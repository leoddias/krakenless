import {
  buildApplyCachedCommand,
  buildApplyCheckCommand,
  buildCommitCommand,
  buildDiscardCommand,
  buildStageCommand,
  buildUnstageCommand,
  type CommitOptions,
} from './commands/stage';
import type { Confirmation } from './confirm';
import { GitError } from './errors';
import { serializeHunks } from './patch';
import { runGit } from './runner';
import type { FileDiff, Hunk } from './types';

/**
 * Turns a caller-supplied {@link Confirmation} into the runner's gate.
 *
 * Every destructive function here takes one. The token can only be minted by
 * the code that actually asked the user (`userConfirmed`), so the gate cannot
 * be satisfied by a module-level constant the way it was before.
 */
function approved(confirmation: Confirmation): { confirmed: true } {
  if (confirmation.reason.length === 0) {
    throw new GitError('needs-confirmation', 'Confirmation is missing its reason');
  }
  return { confirmed: true };
}

/** Staging is recoverable, so it needs no confirmation. */
export function stagePaths(repo: string, paths: string[]): Promise<unknown> {
  return runGit(repo, buildStageCommand(paths), { confirmed: true });
}

/** Unstaging only rewrites the index; the working tree keeps the edits. */
export function unstagePaths(repo: string, paths: string[]): Promise<unknown> {
  return runGit(repo, buildUnstageCommand(paths), { confirmed: true });
}

/**
 * Stages or unstages selected hunks.
 *
 * Two-step on purpose: `git apply --check` first, then the real apply. A patch
 * that would only partially apply is refused before it can touch the index, so
 * the failure mode is "nothing happened" rather than "half of your selection
 * was staged and the rest silently vanished".
 */
export async function applyHunks(
  repo: string,
  file: FileDiff,
  hunks: Hunk[],
  options: { reverse: boolean },
): Promise<void> {
  const patch = serializeHunks(file, hunks);
  // `--unidiff-zero` turns off git's context safety check, so it is only passed
  // when a hunk genuinely has no context lines to check against.
  const zeroContext = hunks.some((hunk) =>
    hunk.lines.every((line) => line.kind !== 'context'),
  );

  try {
    await runGit(repo, buildApplyCheckCommand({ ...options, zeroContext }), {
      confirmed: true,
      stdin: patch,
    });
  } catch (error) {
    if (error instanceof GitError) {
      throw new GitError(
        'command-failed',
        'This selection no longer matches the file. Refresh and try again.',
        { args: error.args, code: error.code, stderr: error.stderr },
      );
    }
    throw error;
  }

  await runGit(repo, buildApplyCachedCommand({ ...options, zeroContext }), {
    confirmed: true,
    stdin: patch,
  });
}

export function commit(repo: string, options: CommitOptions): Promise<unknown> {
  return runGit(repo, buildCommitCommand(options), { confirmed: true });
}

/** Amending rewrites the last commit, so the caller must have asked. */
export function amendCommit(
  repo: string,
  options: CommitOptions,
  confirmation: Confirmation,
): Promise<unknown> {
  return runGit(
    repo,
    buildCommitCommand({ ...options, amend: true }),
    approved(confirmation),
  );
}

export interface DiscardResult {
  /** False when git created no stash; nothing was discarded. */
  discarded: boolean;
  /** Message of the stash(es) holding the discarded changes, when any were made. */
  stashLabel?: string;
  /** Exact commands that bring the changes back, in order. */
  undoCommands: string[];
}

/** Resolves the current stash tip, or null when there are no stashes. */
async function stashTip(repo: string): Promise<string | null> {
  const output = await runGit(
    repo,
    { args: ['rev-parse', '--verify', '--quiet', 'refs/stash'] },
    { allowExitCodes: [1] },
  );
  const oid = output.stdout.trim();
  return oid.length === 0 ? null : oid;
}

/** Paths to discard, split by whether git tracks them. */
export interface DiscardSelection {
  tracked: string[];
  untracked: string[];
}

/** Runs one stash and reports whether it actually created an entry. */
async function stashAway(
  repo: string,
  paths: string[],
  label: string,
  keepIndex: boolean,
  gate: { confirmed: true },
): Promise<string | null> {
  if (paths.length === 0) return null;
  const before = await stashTip(repo);
  await runGit(repo, buildDiscardCommand(paths, label, { keepIndex }), gate);

  // `git stash push -- <path>` exits 0 and creates nothing when the path has no
  // changes. Reporting "recover from the stash" then would send the user to an
  // unrelated, older entry.
  const after = await stashTip(repo);
  return after === null || after === before ? null : after;
}

/**
 * Discards working-tree changes for the selected paths.
 *
 * `--keep-index` on the tracked half is what protects a staged snapshot:
 * without it the stash reverts the staged content to HEAD too, and no
 * `stash pop` puts that back. With it, discarding means "throw away my unstaged
 * edits" — `git restore <path>` semantics — while the edits stay recoverable
 * from the stash commit the result names.
 */
export async function discardPaths(
  repo: string,
  selection: DiscardSelection,
  confirmation: Confirmation,
): Promise<DiscardResult> {
  const gate = approved(confirmation);
  const stashLabel = `krakenless: discarded ${new Date().toISOString()}`;

  // Tracked and untracked paths go in separate stashes: `--keep-index` protects
  // the staged snapshot of tracked files, but git 2.39 fails the whole command
  // when it is combined with an untracked pathspec.
  const trackedOid = await stashAway(repo, selection.tracked, stashLabel, true, gate);
  const untrackedOid = await stashAway(
    repo,
    selection.untracked,
    stashLabel,
    false,
    gate,
  );

  const undoCommands: string[] = [];
  // `stash pop` would conflict, because the worktree now holds the staged
  // content. Checking the paths out of the stash commit restores them cleanly,
  // and addressing it by oid survives later stashes shifting the indices.
  if (trackedOid !== null) {
    undoCommands.push(`git checkout ${trackedOid} -- ${quote(selection.tracked)}`);
  }
  if (untrackedOid !== null) {
    undoCommands.push(`git checkout ${untrackedOid} -- ${quote(selection.untracked)}`);
  }

  if (undoCommands.length === 0) return { discarded: false, undoCommands: [] };
  return { discarded: true, stashLabel, undoCommands };
}

function quote(paths: string[]): string {
  return paths.map((path) => `"${path}"`).join(' ');
}
