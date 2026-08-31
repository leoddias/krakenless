/**
 * Asking the configured AI CLI for a commit message.
 *
 * The app holds no API key and opens no socket. It runs a binary the user
 * already installed and authenticated — the same relationship it has with
 * `git` — so there is no credential to store and nothing to leak. What leaves
 * the machine is decided by that CLI, not by this code.
 */

import { invoke } from '@tauri-apps/api/core';
import { buildStagedDiffCommand, buildStagedStatCommand } from '../git/commands/diff';
import { GitError } from '../git/errors';
import { runGit } from '../git/runner';
import {
  buildCommitMessageCommand,
  cleanCommitMessage,
  diffKindFor,
  type DiffKind,
} from './commands/message';

/** Shape the Rust side returns; identical to the git runner's. */
interface RawOutput {
  stdout: string;
  stderr: string;
  code: number | null;
  timed_out: boolean;
  stdout_lossy: boolean;
}

interface RawRunError {
  kind: 'BadRepoPath' | 'BadArgument' | 'SpawnFailed' | 'IoFailed';
  message: string;
}

export interface GeneratedMessage {
  message: string;
  /**
   * What the model was actually shown. `summary` means the diff was too large
   * to send whole — the UI says so rather than letting the user believe the
   * message was written from the full patch.
   */
  kind: DiffKind;
}

function isRawRunError(value: unknown): value is RawRunError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    typeof (value as { kind: unknown }).kind === 'string'
  );
}

function toError(program: string, raw: unknown): GitError {
  if (isRawRunError(raw)) {
    if (raw.kind === 'SpawnFailed') {
      return new GitError(
        'git-missing',
        `Could not start "${program}". Install it, or set a different command in Settings.`,
      );
    }
    return new GitError('command-failed', raw.message);
  }
  return new GitError('command-failed', String(raw));
}

/**
 * Reads what is staged, in the form that will fit.
 *
 * The full patch is what produces a specific message, so it is preferred. A
 * very large one is replaced by `--stat` rather than cut in half: a truncated
 * patch would yield a confident message about whichever files happened to come
 * first, and nothing downstream could tell that had happened.
 */
async function readStaged(repo: string): Promise<{ text: string; kind: DiffKind }> {
  const patch = (await runGit(repo, buildStagedDiffCommand())).stdout;
  if (patch.trim().length === 0) {
    throw new GitError(
      'command-failed',
      'Nothing is staged, so there is nothing to describe.',
    );
  }
  if (diffKindFor(patch) === 'patch') return { text: patch, kind: 'patch' };

  const stat = (await runGit(repo, buildStagedStatCommand())).stdout;
  return { text: stat, kind: 'summary' };
}

/**
 * Generates a commit message from the staged changes.
 *
 * Never commits. The result goes into the message box for the user to read and
 * edit — a model's sentence about someone's code is a draft, and the person
 * pressing Commit is the one who decides it is true.
 */
export async function generateCommitMessage(
  repo: string,
  program: string,
  model: string,
): Promise<GeneratedMessage> {
  const staged = await readStaged(repo);
  const command = buildCommitMessageCommand(model, staged.kind);

  let raw: RawOutput;
  try {
    raw = await invoke<RawOutput>('ai_run', {
      program,
      args: command.args,
      cwd: repo,
      stdinText: staged.text,
      timeoutMs: command.timeoutMs,
    });
  } catch (error) {
    throw toError(program, error);
  }

  if (raw.timed_out) {
    throw new GitError(
      'timeout',
      `"${program}" did not answer in time. Nothing was changed.`,
    );
  }
  if (raw.code !== 0) {
    // The CLI's own stderr is the useful part — it is what says "not logged
    // in" or "unknown model".
    const detail = raw.stderr.trim().split('\n')[0] ?? `exit ${String(raw.code)}`;
    throw new GitError('command-failed', `"${program}" failed: ${detail}`);
  }

  const message = cleanCommitMessage(raw.stdout);
  if (message.length === 0) {
    throw new GitError('command-failed', `"${program}" returned no message.`);
  }
  return { message, kind: staged.kind };
}
