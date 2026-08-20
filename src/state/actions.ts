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
} from '../git/stage';
import type { CommitOptions } from '../git/commands/stage';
import { userConfirmed } from '../git/confirm';
import { editorLaunch, launch, mergetoolLaunch } from '../config/launch';
import {
  abortMerge,
  applyStash,
  deleteBranch,
  dropStash,
  fetch,
  listBranches,
  listStashes,
  pull,
  push,
  switchBranch,
  switchNewBranch,
  type DeleteBranchOutcome,
} from '../git/refs';
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
    // The working tree is the default selection, so its diff is what the user
    // expects to see immediately — an empty panel on open reads as "no changes".
    await Promise.all([
      refreshStatus(store),
      refreshCommits(store),
      refreshDiff(store),
      refreshBranches(store),
      refreshStashes(store),
    ]);
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
  } finally {
    // Same ordering rule as `operate`: the panels must be current before the
    // controls come back to life.
    await Promise.all([refreshStatus(store), refreshDiff(store)]);
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
  paths: string[],
  confirmationReason: string,
): Promise<DiscardResult | null> {
  const root = currentRoot(store);
  if (root === null || paths.length === 0) return null;
  const count = paths.length;

  let result: DiscardResult | null = null;
  try {
    await mutate(store, async () => {
      // The token is minted from the text the user agreed to; a caller that
      // never asked has nothing to pass here.
      result = await discardPaths(root, paths, userConfirmed(confirmationReason));
    });
  } catch (error) {
    // A discard that failed partway may still have moved work into a stash;
    // its message carries the recovery route, so it must reach the user.
    store.dispatch({ type: 'notice', notice: { tone: 'error', ...describe(error) } });
    return null;
  }

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

// --- refs ------------------------------------------------------------------

export async function refreshBranches(store: Store): Promise<void> {
  const root = currentRoot(store);
  if (root === null) return;
  store.dispatch({ type: 'branches/loading' });
  try {
    const branches = await listBranches(root, { includeRemotes: true });
    store.dispatch({ type: 'branches/loaded', branches });
  } catch (error) {
    store.dispatch({ type: 'branches/failed', ...describe(error) });
  }
}

export async function refreshStashes(store: Store): Promise<void> {
  const root = currentRoot(store);
  if (root === null) return;
  store.dispatch({ type: 'stashes/loading' });
  try {
    store.dispatch({ type: 'stashes/loaded', stashes: await listStashes(root) });
  } catch (error) {
    store.dispatch({ type: 'stashes/failed', ...describe(error) });
  }
}

/** Refreshes everything a branch switch or network operation can change. */
async function refreshAll(store: Store): Promise<void> {
  await Promise.all([
    refreshStatus(store),
    refreshCommits(store),
    refreshDiff(store),
    refreshBranches(store),
    refreshStashes(store),
  ]);
}

function report(store: Store, error: unknown): void {
  store.dispatch({ type: 'notice', notice: { tone: 'error', ...describe(error) } });
}

/** Runs a repository-changing operation, reporting failure as a notice. */
async function operate(store: Store, run: () => Promise<unknown>): Promise<boolean> {
  store.dispatch({ type: 'busy', busy: true });
  try {
    await run();
    return true;
  } catch (error) {
    report(store, error);
    return false;
  } finally {
    // The refresh completes *before* busy clears. Clearing first re-enables
    // every button while the panels still show pre-operation state, so a click
    // aimed at one row can land on another once the new data arrives.
    await refreshAll(store);
    store.dispatch({ type: 'busy', busy: false });
  }
}

export async function fetchRemote(store: Store): Promise<boolean> {
  const root = currentRoot(store);
  if (root === null) return false;
  return operate(store, () => fetch(root, { prune: true }));
}

export async function pullCurrent(store: Store): Promise<boolean> {
  const root = currentRoot(store);
  if (root === null) return false;
  return operate(store, () => pull(root));
}

export async function pushCurrent(
  store: Store,
  options: { remote: string; branch: string; setUpstream?: boolean },
): Promise<boolean> {
  const root = currentRoot(store);
  if (root === null) return false;
  return operate(store, () => push(root, options));
}

export async function switchTo(store: Store, name: string): Promise<boolean> {
  const root = currentRoot(store);
  if (root === null) return false;
  return operate(store, () => switchBranch(root, name));
}

export async function createAndSwitch(
  store: Store,
  name: string,
  startPoint?: string,
): Promise<boolean> {
  const root = currentRoot(store);
  if (root === null) return false;
  return operate(store, () => switchNewBranch(root, name, startPoint));
}

/**
 * Deletes a branch. Without `force` this reports the unmerged warning instead
 * of deleting, so the UI can ask again with the consequence spelled out.
 */
export async function removeBranch(
  store: Store,
  name: string,
  confirmationReason: string,
  options: { force: boolean } = { force: false },
): Promise<DeleteBranchOutcome | null> {
  const root = currentRoot(store);
  if (root === null) return null;

  let outcome: DeleteBranchOutcome | null = null;
  await operate(store, async () => {
    outcome = await deleteBranch(root, name, userConfirmed(confirmationReason), options);
  });

  if (outcome !== null) {
    const result: DeleteBranchOutcome = outcome;
    if (!result.deleted && result.unmergedWarning !== undefined) {
      store.dispatch({
        type: 'notice',
        notice: { tone: 'warning', message: result.unmergedWarning },
      });
    }
  }
  return outcome;
}

export async function restoreStash(
  store: Store,
  entry: { ref: string; oid: string },
  options: { pop: boolean },
  confirmationReason: string,
): Promise<boolean> {
  const root = currentRoot(store);
  if (root === null) return false;
  return operate(store, () =>
    applyStash(root, entry, options, userConfirmed(confirmationReason)),
  );
}

export async function removeStash(
  store: Store,
  entry: { ref: string; oid: string },
  confirmationReason: string,
): Promise<boolean> {
  const root = currentRoot(store);
  if (root === null) return false;
  return operate(store, () => dropStash(root, entry, userConfirmed(confirmationReason)));
}

// --- external tools --------------------------------------------------------

/**
 * Opens a repository file in the user's editor.
 *
 * Failure is reported as a notice rather than thrown: the editor not starting
 * is a configuration problem, not a reason to break the panel the user clicked
 * from.
 */
export async function openInEditor(store: Store, path: string): Promise<boolean> {
  const root = currentRoot(store);
  if (root === null) return false;

  const target = editorLaunch(store.getState().config.editorCommand, path);
  if (target === null) {
    store.dispatch({
      type: 'notice',
      notice: {
        tone: 'warning',
        message: 'No editor is configured. Set one in Settings to open files from here.',
      },
    });
    return false;
  }

  try {
    await launch(target, root);
    return true;
  } catch (error) {
    report(store, error);
    return false;
  }
}

/** Hands one conflicted file to `git mergetool`. */
export async function openMergetool(store: Store, path: string): Promise<boolean> {
  const root = currentRoot(store);
  if (root === null) return false;

  try {
    await launch(mergetoolLaunch(store.getState().config.mergetool, path), root);
    return true;
  } catch (error) {
    report(store, error);
    return false;
  }
}

/**
 * Aborts a merge in progress, returning the tree to its pre-merge state.
 *
 * Destructive: it throws away conflict resolutions made so far, so the caller
 * passes the text the user agreed to.
 */
export async function abortMergeInProgress(
  store: Store,
  confirmationReason: string,
): Promise<boolean> {
  const root = currentRoot(store);
  if (root === null) return false;
  return operate(store, () => abortMerge(root, userConfirmed(confirmationReason)));
}
