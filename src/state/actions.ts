/**
 * The glue between the git layer and the store.
 *
 * Views never call git directly: they dispatch through these functions, which
 * own the loading/error transitions. Every one of them turns a thrown
 * {@link GitError} into an error state carrying the kind, so panels can say
 * something specific instead of "something went wrong".
 */

import { saveConfig } from '../config/store';
import { withRecentRepo, withoutRecentRepo } from '../config/schema';
import { getCommitDiff, getStagedDiff, getWorktreeDiff } from '../git/diff';
import { GitError } from '../git/errors';
import { readLog } from '../git/log';
import { openRepository } from '../git/repository';
import {
  applyHunks,
  commit,
  discardPaths,
  stagePaths,
  unstagePaths,
  type DiscardResult,
  type DiscardSelection,
} from '../git/stage';
import type { CommitOptions } from '../git/commands/stage';
import { userConfirmed } from '../git/confirm';
import { getStatus } from '../git/status';
import type { FileDiff, Hunk } from '../git/types';
import type { Store } from './store';

/** Number of commits the history panel loads at once. */
export const LOG_PAGE_SIZE = 200;

function describe(error: unknown): { message: string; kind?: string } {
  if (error instanceof GitError) {
    return { message: error.message, kind: error.kind };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

/** Opens a repository and loads the first view of it. */
export async function openRepo(store: Store, path: string): Promise<void> {
  store.dispatch({ type: 'repo/opening' });
  try {
    const repo = await openRepository(path);
    store.dispatch({ type: 'repo/opened', repo });
    await rememberRepo(store, repo.root);
    await Promise.all([refreshStatus(store), refreshCommits(store)]);
  } catch (error) {
    store.dispatch({ type: 'repo/failed', ...describe(error) });
  }
}

/** Records the repository in the recent list; a failed save is not fatal. */
async function rememberRepo(store: Store, root: string): Promise<void> {
  const config = withRecentRepo(store.getState().config, root, new Date());
  store.dispatch({ type: 'config/loaded', config });
  try {
    await saveConfig(config);
  } catch {
    // The repo is open either way; losing the recent entry is a cosmetic loss.
  }
}

export async function forgetRepo(store: Store, path: string): Promise<void> {
  const config = withoutRecentRepo(store.getState().config, path);
  store.dispatch({ type: 'config/loaded', config });
  try {
    await saveConfig(config);
  } catch {
    // Same reasoning as rememberRepo.
  }
}

function currentRoot(store: Store): string | null {
  const repo = store.getState().repo;
  return repo.state === 'ready' ? repo.value.root : null;
}

export async function refreshStatus(store: Store): Promise<void> {
  const root = currentRoot(store);
  if (root === null) return;
  store.dispatch({ type: 'status/loading' });
  try {
    store.dispatch({ type: 'status/loaded', status: await getStatus(root) });
  } catch (error) {
    store.dispatch({ type: 'status/failed', ...describe(error) });
  }
}

export async function refreshCommits(store: Store): Promise<void> {
  const root = currentRoot(store);
  if (root === null) return;
  store.dispatch({ type: 'commits/loading' });
  try {
    const commits = await readLog(root, { limit: LOG_PAGE_SIZE, allRefs: true });
    store.dispatch({ type: 'commits/loaded', commits });
  } catch (error) {
    store.dispatch({ type: 'commits/failed', ...describe(error) });
  }
}

/**
 * Loads the diff for whatever is selected: a commit's changes, or the working
 * tree (unstaged plus staged) when nothing is selected.
 */
export async function refreshDiff(store: Store): Promise<void> {
  const root = currentRoot(store);
  if (root === null) return;
  const { commitOid } = store.getState().selection;

  store.dispatch({ type: 'diff/loading' });
  try {
    if (commitOid !== null) {
      store.dispatch({
        type: 'diff/loaded',
        files: await getCommitDiff(root, commitOid),
      });
      return;
    }
    const [unstaged, staged] = await Promise.all([
      getWorktreeDiff(root),
      getStagedDiff(root),
    ]);
    // Staged entries come second: the working tree is what the user is looking
    // at, and a path can legitimately appear on both sides.
    store.dispatch({ type: 'diff/loaded', files: [...unstaged, ...staged] });
  } catch (error) {
    store.dispatch({ type: 'diff/failed', ...describe(error) });
  }
}

/** Selects a commit (or the working tree, with `null`) and loads its diff. */
export async function selectCommit(store: Store, oid: string | null): Promise<void> {
  store.dispatch({ type: 'selection/commit', oid });
  await refreshDiff(store);
}

export function closeRepo(store: Store): void {
  store.dispatch({ type: 'repo/closed' });
}

/**
 * Stages or unstages whole paths, then refreshes what the change affects.
 *
 * `busy` is set for the duration: the UI disables actions while a git command
 * that writes is in flight, so a double click cannot queue two conflicting
 * operations against the same index.
 */
async function mutate(store: Store, run: () => Promise<unknown>): Promise<void> {
  store.dispatch({ type: 'busy', busy: true });
  try {
    await run();
    await Promise.all([refreshStatus(store), refreshDiff(store)]);
  } finally {
    store.dispatch({ type: 'busy', busy: false });
  }
}

export async function stage(store: Store, paths: string[]): Promise<void> {
  const root = currentRoot(store);
  if (root === null || paths.length === 0) return;
  await mutate(store, () => stagePaths(root, paths));
}

export async function unstage(store: Store, paths: string[]): Promise<void> {
  const root = currentRoot(store);
  if (root === null || paths.length === 0) return;
  await mutate(store, () => unstagePaths(root, paths));
}

/** Stages (or unstages, with `reverse`) a selection of hunks from one file. */
export async function stageHunks(
  store: Store,
  file: FileDiff,
  hunks: Hunk[],
  options: { reverse: boolean },
): Promise<void> {
  const root = currentRoot(store);
  if (root === null || hunks.length === 0) return;
  await mutate(store, () => applyHunks(root, file, hunks, options));
}

/**
 * Discards changes to `paths`. Returns the stash label so the UI can tell the
 * user exactly how to get the changes back — the discard is only defensible
 * because that recovery route exists.
 */
export async function discard(
  store: Store,
  selection: DiscardSelection,
  confirmationReason: string,
): Promise<DiscardResult | null> {
  const root = currentRoot(store);
  const count = selection.tracked.length + selection.untracked.length;
  if (root === null || count === 0) return null;

  let result: DiscardResult | null = null;
  await mutate(store, async () => {
    // The token is minted from the text the user agreed to; a caller that never
    // asked has nothing to pass here.
    result = await discardPaths(root, selection, userConfirmed(confirmationReason));
  });

  if (result !== null) {
    const outcome: DiscardResult = result;
    store.dispatch({
      type: 'notice',
      notice: outcome.discarded
        ? {
            tone: 'info',
            message: `Discarded changes to ${count} file(s).`,
            undoHint: outcome.undoCommands.join('\n'),
          }
        : {
            tone: 'warning',
            message: 'Nothing to discard — those paths had no changes.',
          },
    });
  }
  return result;
}

export async function commitStaged(store: Store, options: CommitOptions): Promise<void> {
  const root = currentRoot(store);
  if (root === null) return;
  await mutate(store, () => commit(root, options));
  await refreshCommits(store);
}
