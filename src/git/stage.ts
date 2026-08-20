import {
  buildApplyCachedCommand,
  buildApplyCheckCommand,
  buildCommitCommand,
  buildDiscardCommand,
  buildStageCommand,
  buildUnstageCommand,
  type CommitOptions,
} from './commands/stage';
import { GitError } from './errors';
import { serializeHunks } from './patch';
import { runGit } from './runner';
import type { FileDiff, Hunk } from './types';

/** Everything here mutates the repository, so every call is confirmed. */
const CONFIRMED = { confirmed: true } as const;

export function stagePaths(repo: string, paths: string[]): Promise<unknown> {
  return runGit(repo, buildStageCommand(paths), CONFIRMED);
}

export function unstagePaths(repo: string, paths: string[]): Promise<unknown> {
  return runGit(repo, buildUnstageCommand(paths), CONFIRMED);
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

  try {
    await runGit(repo, buildApplyCheckCommand(options), { ...CONFIRMED, stdin: patch });
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

  await runGit(repo, buildApplyCachedCommand(options), { ...CONFIRMED, stdin: patch });
}

export function commit(repo: string, options: CommitOptions): Promise<unknown> {
  return runGit(repo, buildCommitCommand(options), CONFIRMED);
}

export interface DiscardResult {
  /** Message of the stash that holds the discarded changes, for the UI to show. */
  stashLabel: string;
}

/**
 * Discards working-tree changes for `paths`.
 *
 * Implemented as a path-limited stash, not `git restore`: the changes stay
 * recoverable with `git stash pop`, and paths the user did not select are
 * untouched. The UI is expected to say so — "discarded, recover with
 * `git stash pop`" is the honest message, and it is only true because of this.
 * If the stash fails, nothing was discarded.
 */
export async function discardPaths(
  repo: string,
  paths: string[],
): Promise<DiscardResult> {
  const stashLabel = `krakenless: discarded ${new Date().toISOString()}`;
  await runGit(repo, buildDiscardCommand(paths, stashLabel), CONFIRMED);
  return { stashLabel };
}
