import { invoke } from '@tauri-apps/api/core';
import { isDestructive } from './destructive';
import { GitError, classifyFailure } from './errors';
import type { GitCommand, GitOutput } from './types';

/** Shape the Rust side returns. Snake case is converted here, once. */
interface RawGitOutput {
  stdout: string;
  stderr: string;
  code: number | null;
  timed_out: boolean;
  stdout_lossy: boolean;
}

interface RawGitRunError {
  kind: 'BadRepoPath' | 'BadArgument' | 'SpawnFailed' | 'IoFailed';
  message: string;
}

export interface RunOptions {
  /** Required for commands that can destroy work. */
  confirmed?: boolean;
  /** Exit codes that are expected and must not throw (e.g. 1 from `diff --quiet`). */
  allowExitCodes?: number[];
  /**
   * Accept output that could not be decoded as UTF-8. Only for commands whose
   * result is displayed, never for output that will be parsed into paths.
   */
  allowLossyOutput?: boolean;
}

function isRawRunError(value: unknown): value is RawGitRunError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    typeof (value as { kind: unknown }).kind === 'string'
  );
}

function toGitError(args: string[], raw: unknown): GitError {
  if (isRawRunError(raw)) {
    switch (raw.kind) {
      case 'BadRepoPath':
        return new GitError('bad-repo-path', raw.message, { args });
      case 'BadArgument':
        return new GitError('bad-argument', raw.message, { args });
      case 'SpawnFailed':
        return new GitError(
          'git-missing',
          'Could not start git. Is it installed and on PATH?',
          {
            args,
          },
        );
      case 'IoFailed':
        return new GitError('command-failed', raw.message, { args });
    }
  }
  return new GitError('command-failed', String(raw), { args });
}

/**
 * Runs a built command. Throws {@link GitError} on failure — callers never see
 * a silent non-zero exit, and stderr is never swallowed.
 */
export async function runGit(
  repo: string,
  command: GitCommand,
  options: RunOptions = {},
): Promise<GitOutput> {
  // The builder's flag is a hint; the arguments are the authority. A builder
  // that forgets `destructive: true` must not be able to bypass the gate.
  if ((command.destructive || isDestructive(command.args)) && !options.confirmed) {
    throw new GitError(
      'needs-confirmation',
      'This operation needs explicit confirmation',
      {
        args: command.args,
      },
    );
  }

  let raw: RawGitOutput;
  try {
    raw = await invoke<RawGitOutput>('git_run', {
      repo,
      args: command.args,
      timeoutMs: command.timeoutMs ?? null,
    });
  } catch (error) {
    throw toGitError(command.args, error);
  }

  const output: GitOutput = {
    stdout: raw.stdout,
    stderr: raw.stderr,
    code: raw.code,
    timedOut: raw.timed_out,
    stdoutLossy: raw.stdout_lossy,
  };

  if (output.timedOut) {
    throw classifyFailure(command.args, output);
  }
  const allowed = options.allowExitCodes ?? [];
  // `null` means the process was killed; never treat that as an allowed code.
  if (output.code === null || !(output.code === 0 || allowed.includes(output.code))) {
    throw classifyFailure(command.args, output);
  }
  if (output.stdoutLossy && !options.allowLossyOutput) {
    throw new GitError(
      'undecodable-output',
      'git returned output that is not valid UTF-8; paths from it cannot be trusted',
      { args: command.args, code: output.code, stderr: output.stderr },
    );
  }
  return output;
}

/** Convenience for the common case: run and take stdout with trailing newlines removed. */
export async function runGitText(
  repo: string,
  command: GitCommand,
  options: RunOptions = {},
): Promise<string> {
  const output = await runGit(repo, command, options);
  return output.stdout.replace(/\r?\n$/, '');
}
