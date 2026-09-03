/**
 * The glue between the git layer and the store.
 *
 * Views never call git directly: they dispatch through these functions, which
 * own the loading/error transitions. Every one of them turns a thrown
 * {@link GitError} into an error state carrying the kind, so panels can say
 * something specific instead of "something went wrong".
 */

import { saveConfig } from '../config/store';
import { cacheDiff, clearDiffCache, getCachedDiff } from './diffCache';
import { describeFetchNews, fetchAndCompare, type FetchNews } from './fetchNews';
import { withRecentRepo, withoutRecentRepo } from '../config/schema';
import { getCommitDiff, getStagedDiff, getWorktreeDiff } from '../git/diff';
import { generateCommitMessage, type GeneratedMessage } from '../ai/message';
import { GitError } from '../git/errors';
import { readLog } from '../git/log';
import { openRepository } from '../git/repository';
import {
  applyHunks,
  commit,
  discardHunks,
  discardPaths,
  readBackupBlob,
  stagePaths,
  unstagePaths,
  type DiscardResult,
  type HunkDiscardResult,
} from '../git/stage';
import type { CommitOptions } from '../git/commands/stage';
import { userConfirmed } from '../git/confirm';
import { editorLaunch, launch, mergetoolLaunch } from '../config/launch';
import {
  cherryPick,
  createTag,
  mergeInto,
  rebaseOnto,
  resetTo,
  revertCommit,
  type MergeOutcome,
  type RebaseOutcome,
  type ResetMode,
} from '../git/commits';
import {
  abortMerge,
  applyStash,
  checkoutRevision,
  createBranch,
  deleteBranch,
  dropStash,
  listBranches,
  listRemotes,
  listStashes,
  pull,
  pullMerge,
  push,
  pushTag,
  switchBranch,
  switchNewBranch,
  type DeleteBranchOutcome,
  type PullMergeOutcome,
} from '../git/refs';
import { getStatus } from '../git/status';
import {
  abortOperation,
  continueOperation,
  noOperation,
  readOperation,
  skipOperation,
  type ContinuableKind,
  type OperationKind,
} from '../git/operation';
import { hasConflictMarkers } from '../git/conflict';
import { listWorktreeSummaries } from '../git/worktrees';
import { FileError, openWorktreeFile, saveWorktreeFile, type OpenFile } from '../fs/file';
import type { FileDiff, Hunk } from '../git/types';
import type { DiscardBackup, Store } from './store';

/** Number of commits the history panel loads at once. */
/** Commits a fresh config reads into the graph; Settings can raise it. */
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
    // Not strictly needed for correctness — the cache key carries the root —
    // but a fresh repository should not keep another one's diffs in memory.
    clearDiffCache();
    store.dispatch({ type: 'repo/opened', repo });
    await rememberRepo(store, repo.root);
    // The working tree is the default selection, so its diff is what the user
    // expects to see immediately — an empty panel on open reads as "no changes".
    await Promise.all([
      refreshStatus(store),
      refreshCommits(store),
      refreshDiff(store),
      refreshBranches(store),
      refreshRemotes(store),
      refreshStashes(store),
      refreshWorktrees(store),
      // A repository can be opened *while* stopped mid-rebase — the app was
      // closed and reopened, or the rebase was started from a terminal. The
      // way out has to be on screen from the first frame.
      refreshOperation(store),
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

/**
 * The open repository, root *and* git directory.
 *
 * The rebase state lives in the git directory, and in a linked worktree that is
 * not `<root>/.git` — it is a file pointing somewhere else entirely. Anything
 * reading git's own bookkeeping needs the resolved path, not the root.
 */
function currentRepo(store: Store): { root: string; gitDir: string } | null {
  const repo = store.getState().repo;
  return repo.state === 'ready'
    ? { root: repo.value.root, gitDir: repo.value.gitDir }
    : null;
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
    // The user's limit, not the constant: `LOG_PAGE_SIZE` is only the default
    // that lands in a fresh config, and a repository someone reads far back in
    // is exactly the one where the default is wrong.
    const limit = store.getState().config.historyLimit;
    const commits = await readLog(root, { limit, allRefs: true });
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

  // A commit's diff is immutable, so a cached one is served without touching
  // git — and without a loading flash, which on a hit would only make the
  // panel blink between two renders of the same data.
  if (commitOid !== null) {
    const cached = getCachedDiff(root, commitOid);
    if (cached !== undefined) {
      store.dispatch({ type: 'diff/loaded', files: [...cached] });
      return;
    }
  }

  // True while the answer being awaited is still the question on screen. The
  // selection can change mid-flight — a slow commit diff, a click on a cached
  // one that answers instantly — and a late dispatch would put one commit's
  // diff behind another commit's selection, with the wrong side's stage and
  // discard buttons attached to it. A dropped result costs nothing: whichever
  // selection replaced this one runs its own refresh.
  const stillCurrent = (): boolean =>
    currentRoot(store) === root && store.getState().selection.commitOid === commitOid;

  store.dispatch({ type: 'diff/loading' });
  try {
    if (commitOid !== null) {
      const files = await getCommitDiff(root, commitOid);
      // Cached regardless: the data is correct for its oid even when the user
      // has moved on, and the next visit gets it for free.
      cacheDiff(root, commitOid, files);
      if (stillCurrent()) store.dispatch({ type: 'diff/loaded', files });
      return;
    }
    const [unstaged, staged] = await Promise.all([
      getWorktreeDiff(root),
      getStagedDiff(root),
    ]);
    // Staged entries come second: the working tree is what the user is looking
    // at, and a path can legitimately appear on both sides.
    if (stillCurrent()) {
      store.dispatch({ type: 'diff/loaded', files: [...unstaged, ...staged] });
    }
  } catch (error) {
    if (stillCurrent()) store.dispatch({ type: 'diff/failed', ...describe(error) });
  }
}

/**
 * Selects a commit (or the working tree, with `null`) and loads its diff.
 *
 * Selecting the working tree re-reads the *status* as well, not just the diff.
 * They are two different git commands answering one question, and refreshing
 * only one of them is how the working-tree panel ends up saying "clean" while
 * the diff beside it lists a modified file. A commit needs no status: it is
 * history, and nothing about it can have changed since the list was read.
 */
export async function selectCommit(store: Store, oid: string | null): Promise<void> {
  store.dispatch({ type: 'selection/commit', oid });
  await (oid === null
    ? Promise.all([refreshStatus(store), refreshDiff(store)])
    : refreshDiff(store));
}

export function closeRepo(store: Store): void {
  // The diffs of a closed repository have no business staying in memory.
  clearDiffCache();
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

/**
 * Asks the configured AI CLI for a commit message and returns it.
 *
 * Returns the draft rather than writing it into the store: the message belongs
 * in the box the user is editing, and this function must not be able to commit
 * anything. Errors come back as a thrown {@link GitError} so the commit box can
 * show them where the user is looking, instead of a notice somewhere else.
 *
 * Not routed through `mutate`: nothing here writes to the repository, so the
 * panels must not be reloaded and the destructive controls must not be
 * disabled. It sets `busy` only so the button cannot be pressed twice.
 */
export async function suggestCommitMessage(store: Store): Promise<GeneratedMessage> {
  const root = currentRoot(store);
  if (root === null) {
    throw new GitError('command-failed', 'No repository is open.');
  }
  const { aiCommand, aiModel } = store.getState().config;
  if (aiCommand.trim().length === 0) {
    throw new GitError(
      'command-failed',
      'No AI command is configured. Set one in Settings.',
    );
  }

  store.dispatch({ type: 'busy', busy: true });
  try {
    return await generateCommitMessage(root, aiCommand, aiModel);
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
 * Discards one hunk from the working tree.
 *
 * The undo command is surfaced as a notice rather than kept internally: this
 * removes an edit git was never told about, and the route back only counts as
 * a route back if the user is shown it.
 */
export async function discardHunk(
  store: Store,
  file: FileDiff,
  hunks: Hunk[],
  confirmationReason: string,
): Promise<void> {
  const root = currentRoot(store);
  if (root === null || hunks.length === 0) return;

  let result: HunkDiscardResult | null = null;
  try {
    await mutate(store, async () => {
      result = await discardHunks(root, file, hunks, userConfirmed(confirmationReason));
    });
  } catch (error) {
    store.dispatch({ type: 'notice', notice: { tone: 'error', ...describe(error) } });
    return;
  }

  if (result !== null) {
    const outcome: HunkDiscardResult = result;
    // Recorded before the notice: the notice is the announcement, this is the
    // route back, and the route back must not depend on the announcement
    // surviving the next click.
    store.dispatch({
      type: 'discard/recorded',
      backup: {
        path: outcome.path,
        blobOid: outcome.blobOid,
        at: new Date().toISOString(),
      },
    });
    const count = hunks.length;
    store.dispatch({
      type: 'notice',
      notice: {
        tone: 'info',
        message:
          `Discarded ${String(count)} hunk${count === 1 ? '' : 's'} from ` +
          `${file.newPath}. Undo it from Recent discards.`,
      },
    });
  }
}

/**
 * Puts a discarded file back from its backup blob.
 *
 * Writes through the same worktree writer the conflict resolver uses rather
 * than telling the user to run a shell redirect: `git cat-file -p <oid> > path`
 * is byte-exact in `cmd.exe` and `pwsh`, but Windows PowerShell 5.1 treats `>`
 * as `Out-File` and re-encodes the stream to UTF-16LE with a BOM. Doing the
 * write here is the only way the promise of recovery is actually kept on the
 * platform this app targets.
 */
export async function undoDiscard(store: Store, backup: DiscardBackup): Promise<void> {
  const root = currentRoot(store);
  if (root === null) return;

  try {
    await mutate(store, async () => {
      const contents = await readBackupBlob(root, backup.blobOid);
      // Re-read for the current stamp only. The blob's bytes are written back
      // verbatim — `saveWorktreeFile` reformats nothing — so the line endings
      // and the missing trailing newline come back as they were.
      const current = await openWorktreeFile(root, backup.path);
      await saveWorktreeFile(root, current, contents);
    });
  } catch (error) {
    store.dispatch({ type: 'notice', notice: { tone: 'error', ...describe(error) } });
    return;
  }

  // Only once the write succeeded: dropping the record on a failed restore
  // would throw away the oid that is still the only way back.
  store.dispatch({ type: 'discard/forgotten', blobOid: backup.blobOid });
  store.dispatch({
    type: 'notice',
    notice: { tone: 'info', message: `Restored ${backup.path} from its backup.` },
  });
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
    // A discard that failed partway may still have moved work into a stash, and
    // the message carries the route back. It is dispatched *and* rethrown: a
    // caller that treated this as "nothing happened" would tell the user there
    // is nothing to recover while a stash holds their work.
    store.dispatch({ type: 'notice', notice: { tone: 'error', ...describe(error) } });
    throw error;
  }

  if (result !== null) {
    const outcome: DiscardResult = result;
    store.dispatch({
      type: 'notice',
      notice: outcome.discarded
        ? {
            tone: 'info',
            // Anything the command cannot bring back is said here; a command
            // shown above a path list it does not cover reads as "this
            // restores all of them".
            message: [
              `Discarded changes to ${count} file(s).`,
              ...(outcome.notes ?? []),
            ].join(' '),
            // Only when there is something to run: an empty hint renders as
            // "Run this to undo:" above nothing, promising a route the code
            // deliberately decided not to offer.
            ...(outcome.undoCommands.length === 0
              ? {}
              : { undoHint: outcome.undoCommands.join('\n') }),
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

export async function refreshRemotes(store: Store): Promise<void> {
  const root = currentRoot(store);
  if (root === null) return;
  store.dispatch({ type: 'remotes/loading' });
  try {
    store.dispatch({ type: 'remotes/loaded', remotes: await listRemotes(root) });
  } catch (error) {
    store.dispatch({ type: 'remotes/failed', ...describe(error) });
  }
}

/**
 * Reads the repository's worktrees and how much is uncommitted in each.
 *
 * The current checkout is skipped: its uncommitted work is the whole rest of
 * the window, and counting it again here would be a second answer to a question
 * already on screen.
 */
export async function refreshWorktrees(store: Store): Promise<void> {
  const root = currentRoot(store);
  if (root === null) return;
  store.dispatch({ type: 'worktrees/loading' });
  try {
    const worktrees = await listWorktreeSummaries(root, { skip: root });
    store.dispatch({ type: 'worktrees/loaded', worktrees });
  } catch (error) {
    store.dispatch({ type: 'worktrees/failed', ...describe(error) });
  }
}

/**
 * Reads which operation the repository is stopped in the middle of.
 *
 * Never fails loudly: an unreadable answer becomes "nothing in progress", which
 * hides the continue/abort controls rather than offering the wrong ones. The
 * wrong ones are what stranded people before — `git merge --abort` during a
 * rebase fails, and there was nothing else on offer.
 */
export async function refreshOperation(store: Store): Promise<void> {
  const repo = currentRepo(store);
  if (repo === null) return;
  try {
    const operation = await readOperation(repo.root, repo.gitDir);
    store.dispatch({ type: 'operation/read', operation });
  } catch {
    store.dispatch({ type: 'operation/read', operation: noOperation() });
  }
}

/**
 * Resumes the stopped operation once its conflicts are staged.
 *
 * Git refuses while anything is still unmerged and says exactly that, which is
 * a better message than one this app could invent — so the refusal is passed
 * through rather than pre-empted.
 */
export async function continueStoppedOperation(
  store: Store,
  kind: ContinuableKind,
  confirmationReason: string,
): Promise<boolean> {
  const root = currentRoot(store);
  if (root === null) return false;
  return operate(store, () =>
    continueOperation(root, kind, userConfirmed(confirmationReason)),
  );
}

/** Drops the commit the operation is stopped on and moves to the next one. */
export async function skipStoppedCommit(
  store: Store,
  kind: ContinuableKind,
  confirmationReason: string,
): Promise<boolean> {
  const root = currentRoot(store);
  if (root === null) return false;
  return operate(store, () =>
    skipOperation(root, kind, userConfirmed(confirmationReason)),
  );
}

/**
 * Abandons the stopped operation, whichever one it actually is.
 *
 * The `kind` comes from {@link refreshOperation}, never from a guess: aborting
 * a rebase as though it were a merge is the failure this whole path exists to
 * make impossible.
 */
export async function abortStoppedOperation(
  store: Store,
  kind: OperationKind,
  confirmationReason: string,
): Promise<boolean> {
  const root = currentRoot(store);
  if (root === null) return false;
  return operate(store, () =>
    abortOperation(root, kind, userConfirmed(confirmationReason)),
  );
}

/**
 * Writes a resolved file and marks it resolved.
 *
 * Two steps, in this order and no other: the bytes reach disk first, and only a
 * successful write is followed by `git add`. Staging first and writing second
 * would, on a failed write, leave the index claiming a resolution that the file
 * does not contain — a conflict committed as though somebody had settled it.
 *
 * The text is refused outright if it still carries conflict markers. That is
 * not a nicety: `git add` on a marked-up file is the single most common way a
 * conflict ends up in a commit, and the app must not be the thing that does it.
 */
export async function resolveConflict(
  store: Store,
  path: string,
  contents: string,
): Promise<boolean> {
  const root = currentRoot(store);
  if (root === null) return false;

  if (hasConflictMarkers(contents)) {
    store.dispatch({
      type: 'notice',
      notice: {
        tone: 'error',
        message: `"${path}" still contains conflict markers, so it was not staged. Resolve every block first.`,
      },
    });
    return false;
  }

  return operate(store, async () => {
    // Re-read for the stamp: the write refuses if the file changed on disk
    // since, which is what stops the resolver from overwriting an edit that
    // arrived from an editor while it was open.
    const file = await openWorktreeFile(root, path);
    await saveWorktreeFile(root, file, contents);
    await stagePaths(root, [path]);
  });
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
export async function refreshAllPanels(store: Store): Promise<void> {
  await refreshAll(store);
}

async function refreshAll(store: Store): Promise<void> {
  await Promise.all([
    refreshStatus(store),
    refreshCommits(store),
    refreshDiff(store),
    refreshBranches(store),
    refreshRemotes(store),
    refreshStashes(store),
    refreshWorktrees(store),
    refreshOperation(store),
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

/**
 * Fetches on demand, and says what came back.
 *
 * A fetch that works and a fetch that silently does nothing look identical
 * without this: no panel changes when the remote has not moved, so the button
 * reads as broken. The answer is always stated — including "nothing new",
 * which is the answer the user is usually hoping for.
 */
export async function fetchRemote(store: Store): Promise<boolean> {
  const root = currentRoot(store);
  if (root === null) return false;

  const outcome: { news: FetchNews | null } = { news: null };
  const ok = await operate(store, async () => {
    outcome.news = await fetchAndCompare(root, { prune: true });
  });
  if (!ok) return false;

  // `null` news means the ref comparison failed, not that nothing arrived;
  // claiming "nothing new" there would be a guess presented as a fact.
  const message =
    outcome.news === null
      ? 'Fetched.'
      : (describeFetchNews(outcome.news) ?? 'Fetched: nothing new.');
  store.dispatch({ type: 'notice', notice: { tone: 'info', message } });
  return true;
}

export async function pullCurrent(store: Store): Promise<boolean> {
  const root = currentRoot(store);
  if (root === null) return false;
  return operate(store, () => pull(root));
}

/**
 * The explicit merge-pull for a diverged branch. Follows `mergeRefInto`'s
 * shape: a conflicted stop is reported as a warning next to the conflict
 * banner, not as a failure — git did what the user confirmed, up to the point
 * where only they can decide. Returns the outcome (or `null` for a failure,
 * already reported as a notice) so the toolbar can describe what actually
 * happened instead of a generic "finished".
 */
export async function pullMergeCurrent(
  store: Store,
  confirmationReason: string,
): Promise<PullMergeOutcome | null> {
  const root = currentRoot(store);
  if (root === null) return null;

  let outcome: PullMergeOutcome | null = null;
  const ran = await operate(store, async () => {
    outcome = await pullMerge(root, userConfirmed(confirmationReason));
  });
  if (!ran) return null;

  if (outcome === 'conflicted') {
    store.dispatch({
      type: 'notice',
      notice: {
        tone: 'warning',
        message:
          'The pull stopped on merge conflicts. Resolve them, then commit the merge — or abort it from the conflict banner.',
      },
    });
  }
  return outcome;
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

// --- one commit from the history ------------------------------------------

/** Checks a commit out directly, leaving HEAD detached. */
export async function checkoutCommit(store: Store, oid: string): Promise<boolean> {
  const root = currentRoot(store);
  if (root === null) return false;
  return operate(store, () => checkoutRevision(root, oid));
}

/**
 * Creates a branch at `oid`, and switches to it unless asked not to.
 *
 * Both routes go through `switch`/`branch` rather than a forced checkout, so a
 * working tree with changes in it is a refusal from git, never an overwrite.
 */
export async function createBranchAt(
  store: Store,
  name: string,
  oid: string,
  options: { checkout: boolean },
): Promise<boolean> {
  const root = currentRoot(store);
  if (root === null) return false;
  return operate(store, () =>
    options.checkout ? switchNewBranch(root, name, oid) : createBranch(root, name, oid),
  );
}

/** Creates a tag at `oid`; annotated when a message is given. */
export async function createTagAt(
  store: Store,
  name: string,
  oid: string,
  options: { message?: string } = {},
): Promise<boolean> {
  const root = currentRoot(store);
  if (root === null) return false;
  return operate(store, () => createTag(root, name, oid, options));
}

/**
 * Publishes a tag that so far exists only here.
 *
 * Separate from creating it, and offered separately, because the two are
 * genuinely different decisions: a tag is often made to mark something locally
 * long before anyone else should see it.
 */
export async function pushTagTo(
  store: Store,
  remote: string,
  tag: string,
): Promise<boolean> {
  const root = currentRoot(store);
  if (root === null) return false;
  const pushed = await operate(store, () => pushTag(root, remote, tag));
  if (pushed) {
    store.dispatch({
      type: 'notice',
      notice: { tone: 'info', message: `Pushed tag ${tag} to ${remote}.` },
    });
  }
  return pushed;
}

/** Replays `oid` on top of HEAD as a new commit. */
export async function cherryPickCommit(store: Store, oid: string): Promise<boolean> {
  const root = currentRoot(store);
  if (root === null) return false;
  return operate(store, () => cherryPick(root, oid));
}

/** Records a new commit undoing `oid`. */
export async function revertCommitOnHead(store: Store, oid: string): Promise<boolean> {
  const root = currentRoot(store);
  if (root === null) return false;
  return operate(store, () => revertCommit(root, oid));
}

/**
 * Replays `branch` onto `oid`.
 *
 * `branch` is the name the menu item showed, and the git layer refuses if HEAD
 * has moved off it since — the confirmation the user gave was about that
 * branch and no other.
 */
/**
 * Replays `branch` onto `oid`, stashing uncommitted work around it.
 *
 * The one outcome that must never pass in silence is an autostash git could not
 * re-apply: the rebase succeeded, so nothing looks wrong, while the working
 * tree holds conflict markers and the user's changes sit in a stash they were
 * never told about. It is reported as a warning naming both.
 */
export async function rebaseBranchOnto(
  store: Store,
  branch: string,
  oid: string,
  confirmationReason: string,
): Promise<boolean> {
  const root = currentRoot(store);
  if (root === null) return false;

  let outcome: RebaseOutcome | null = null;
  const ran = await operate(store, async () => {
    outcome = await rebaseOnto(root, branch, oid, userConfirmed(confirmationReason));
  });
  if (!ran) return false;

  if (outcome === 'autostash-conflicted') {
    store.dispatch({
      type: 'notice',
      notice: {
        tone: 'warning',
        message: `${branch} was rebased, but your stashed changes did not come back cleanly: the working tree has conflict markers and the changes are still in the stash git named "autostash". Resolve the files, then drop that stash — or reset them and pop it again.`,
      },
    });
  }
  return true;
}

/**
 * Merges `ref` into `branch`.
 *
 * `label` is what the user called the thing being merged — a branch name, or a
 * short sha for a commit that carries no ref — and it is only ever used in the
 * sentence that reports what happened.
 *
 * A conflicted merge is reported as news, not as an error: git stopped where it
 * always stops, the repository is mid-merge, and the conflict panel that
 * appears underneath this notice is where the job gets finished. Calling that a
 * failure would contradict the banner sitting next to it.
 */
export async function mergeRefInto(
  store: Store,
  branch: string,
  ref: string,
  label: string,
  confirmationReason: string,
): Promise<boolean> {
  const root = currentRoot(store);
  if (root === null) return false;

  let outcome: MergeOutcome | null = null;
  const ran = await operate(store, async () => {
    outcome = await mergeInto(root, branch, ref, userConfirmed(confirmationReason));
  });
  if (!ran) return false;

  store.dispatch({
    type: 'notice',
    notice:
      outcome === 'conflicted'
        ? {
            tone: 'warning',
            message: `Merging ${label} into ${branch} stopped on conflicts. Resolve them, then commit the merge — or abort it from the conflict banner.`,
          }
        : { tone: 'info', message: `Merged ${label} into ${branch}.` },
  });
  return true;
}

/** Moves `branch` to `oid`. Same guard, same reason. */
export async function resetBranchTo(
  store: Store,
  branch: string,
  oid: string,
  mode: ResetMode,
  confirmationReason: string,
): Promise<boolean> {
  const root = currentRoot(store);
  if (root === null) return false;
  return operate(store, () =>
    resetTo(root, branch, oid, mode, userConfirmed(confirmationReason)),
  );
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

/**
 * Opens a working-tree file in the in-app editor.
 *
 * Errors are thrown rather than turned into a notice: the editor has to say
 * different things for "this file is binary" and "this file is gone", and the
 * shell's notice bar is one line for the whole window.
 */
export async function openFileForEdit(store: Store, path: string): Promise<OpenFile> {
  const root = currentRoot(store);
  if (root === null) {
    throw new FileError('not-found', 'No repository is open.');
  }
  return openWorktreeFile(root, path);
}

/**
 * Writes an edited file back to the working tree.
 *
 * `busy` is held for the write and the refresh that follows, for the same
 * reason staging does: a second save queued against a stamp that is already
 * stale would be refused, and the controls should not invite it. The panels are
 * re-read whether or not the write succeeded — on a refusal the file on disk is
 * exactly what the user needs to see.
 */
export async function saveEditedFile(
  store: Store,
  file: OpenFile,
  contents: string,
): Promise<OpenFile> {
  const root = currentRoot(store);
  if (root === null) {
    throw new FileError('write-failed', 'No repository is open.');
  }

  store.dispatch({ type: 'busy', busy: true });
  try {
    return await saveWorktreeFile(root, file, contents);
  } finally {
    await Promise.all([refreshStatus(store), refreshDiff(store)]);
    store.dispatch({ type: 'busy', busy: false });
  }
}
