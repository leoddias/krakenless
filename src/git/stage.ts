import {
  buildApplyCachedCommand,
  buildApplyCheckCommand,
  buildCommitCommand,
  buildDiscardCommand,
  buildStageCommand,
  buildUnstageCommand,
  type CommitOptions,
} from './commands/stage';
import { pathspec } from './argsafety';
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

/**
 * Splits the requested paths into what git actually needs discarding.
 *
 * Derived here, never taken from the caller: `keepIndex` is the only thing
 * standing between a discard and losing a staged snapshot, and a tracked path
 * mistakenly passed as untracked would lose it silently, exit 0, no warning.
 * Paths whose worktree side matches the index are dropped entirely — stashing
 * those creates an entry and changes nothing, so the user would be told their
 * changes were discarded while the file sits untouched.
 */
async function planDiscard(
  repo: string,
  paths: string[],
): Promise<{ tracked: string[]; untracked: string[] }> {
  const listed = await runGit(repo, { args: ['ls-files', '-z', ...pathspec(paths)] });
  const tracked = new Set(
    listed.stdout.split('\u0000').filter((path) => path.length > 0),
  );

  // Worktree-vs-index differences: exactly the paths a discard would change.
  const dirty = await runGit(repo, {
    args: ['diff', '--name-only', '-z', ...pathspec(paths)],
  });
  const changed = new Set(dirty.stdout.split('\u0000').filter((path) => path.length > 0));

  return {
    tracked: paths.filter((path) => tracked.has(path) && changed.has(path)),
    untracked: paths.filter((path) => !tracked.has(path)),
  };
}

/**
 * Runs one stash phase and returns the oid it created, if any.
 *
 * A failure still has to report the oid: `stash push --keep-index` on an
 * untracked path can fail *after* stashing the file and removing it from disk,
 * and losing that oid to an exception means the file is gone with no route back.
 */
async function stashAway(
  repo: string,
  paths: string[],
  label: string,
  keepIndex: boolean,
  gate: { confirmed: true },
): Promise<string | null> {
  if (paths.length === 0) return null;
  const before = await stashTip(repo);

  try {
    await runGit(repo, buildDiscardCommand(paths, label, { keepIndex }), gate);
  } catch (error) {
    const created = await stashTip(repo);
    if (created !== null && created !== before) {
      throw new StashedButFailed(created);
    }
    throw error;
  }

  // `git stash push -- <path>` exits 0 and creates nothing when there is
  // nothing to save; reporting a recovery route then would point at an
  // unrelated, older entry.
  const after = await stashTip(repo);
  return after === null || after === before ? null : after;
}

/** Carries the stash oid out of a failed phase so the undo route survives. */
class StashedButFailed extends Error {
  readonly oid: string;

  constructor(oid: string) {
    super('The discard failed after stashing');
    this.name = 'StashedButFailed';
    this.oid = oid;
  }
}

/**
 * Discards working-tree changes for the given paths.
 *
 * `--keep-index` on the tracked half protects a staged snapshot: without it the
 * stash reverts staged content to HEAD too, and nothing puts that back. Git
 * 2.39 rejects that flag together with an untracked pathspec, so untracked
 * paths go into their own stash — they have no index entry to protect anyway.
 */
export async function discardPaths(
  repo: string,
  paths: string[],
  confirmation: Confirmation,
): Promise<DiscardResult> {
  const gate = approved(confirmation);
  const stashLabel = `krakenless: discarded ${new Date().toISOString()}`;
  const plan = await planDiscard(repo, paths);

  const undoCommands: string[] = [];
  const addUndo = (oid: string, forPaths: string[]): void => {
    // `git checkout <oid> -- <path>` would write the *index* too, clobbering
    // the staged snapshot --keep-index just protected. `restore --worktree`
    // touches only the working tree, which is the exact inverse of a discard.
    undoCommands.push(`git restore --source=${oid} --worktree -- ${quote(forPaths)}`);
  };

  try {
    const trackedOid = await stashAway(repo, plan.tracked, stashLabel, true, gate);
    if (trackedOid !== null) addUndo(trackedOid, plan.tracked);

    const untrackedOid = await stashAway(repo, plan.untracked, stashLabel, false, gate);
    if (untrackedOid !== null) addUndo(untrackedOid, plan.untracked);
  } catch (error) {
    if (error instanceof StashedButFailed) {
      // Work was moved to a stash before the failure; the user must be told
      // where it went, so the recovery route travels with the error.
      addUndo(error.oid, paths);
      throw new GitError(
        'command-failed',
        `The discard failed partway. Your changes are in a stash: ${undoCommands.join(' ; ')}`,
        { args: ['stash', 'push'] },
      );
    }
    throw error;
  }

  if (undoCommands.length === 0) return { discarded: false, undoCommands: [] };
  return { discarded: true, stashLabel, undoCommands };
}

/** Quotes paths for a command the user copy-pastes into their own shell. */
function quote(paths: string[]): string {
  return paths.map((path) => `"${path.replace(/(["$`\\])/g, '\\$1')}"`).join(' ');
}
