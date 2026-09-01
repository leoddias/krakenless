import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeRepo,
  fetchRemote,
  pullCurrent,
  removeBranch,
  removeStash,
  switchTo,
  commitStaged,
  discard,
  forgetRepo,
  openRepo,
  refreshDiff,
  selectCommit,
  stage,
  stageHunks,
  undoDiscard,
  unstage,
} from './actions';
import { createStore, isBusy } from './store';
import { GitError } from '../git/errors';

const openRepository = vi.hoisted(() => vi.fn());
const getStatus = vi.hoisted(() => vi.fn());
const readLog = vi.hoisted(() => vi.fn());
const getWorktreeDiff = vi.hoisted(() => vi.fn());
const getStagedDiff = vi.hoisted(() => vi.fn());
const getCommitDiff = vi.hoisted(() => vi.fn());
const saveConfig = vi.hoisted(() => vi.fn());
const stagePaths = vi.hoisted(() => vi.fn());
const unstagePaths = vi.hoisted(() => vi.fn());
const applyHunks = vi.hoisted(() => vi.fn());
const commit = vi.hoisted(() => vi.fn());
const discardPaths = vi.hoisted(() => vi.fn());
const discardHunks = vi.hoisted(() => vi.fn());
const readBackupBlob = vi.hoisted(() => vi.fn());
const openWorktreeFile = vi.hoisted(() => vi.fn());
const saveWorktreeFile = vi.hoisted(() => vi.fn());
const listBranches = vi.hoisted(() => vi.fn());
const listStashes = vi.hoisted(() => vi.fn());
const fetchRemoteFn = vi.hoisted(() => vi.fn());
const readRefSnapshot = vi.hoisted(() => vi.fn());
const pullFn = vi.hoisted(() => vi.fn());
const pushFn = vi.hoisted(() => vi.fn());
const switchBranch = vi.hoisted(() => vi.fn());
const switchNewBranch = vi.hoisted(() => vi.fn());
const deleteBranch = vi.hoisted(() => vi.fn());
const applyStash = vi.hoisted(() => vi.fn());
const dropStash = vi.hoisted(() => vi.fn());

vi.mock('../git/repository', () => ({ openRepository }));
vi.mock('../git/status', () => ({ getStatus }));
vi.mock('../git/log', () => ({ readLog }));
vi.mock('../git/diff', () => ({ getWorktreeDiff, getStagedDiff, getCommitDiff }));
vi.mock('../config/store', () => ({ saveConfig }));
vi.mock('../git/refs', () => ({
  listBranches,
  listStashes,
  fetch: fetchRemoteFn,
  readRefSnapshot,
  pull: pullFn,
  push: pushFn,
  switchBranch,
  switchNewBranch,
  deleteBranch,
  applyStash,
  dropStash,
}));
vi.mock('../git/stage', () => ({
  stagePaths,
  unstagePaths,
  applyHunks,
  commit,
  discardPaths,
  discardHunks,
  readBackupBlob,
  discardHunkRefusal: () => null,
}));
vi.mock('../fs/file', () => ({
  openWorktreeFile,
  saveWorktreeFile,
  FileError: class extends Error {},
}));

const REPO = {
  root: 'C:/repos/app',
  gitDir: 'C:/repos/app/.git',
  bare: false,
  empty: false,
};
const STATUS = {
  branch: 'main',
  head: 'abc',
  detached: false,
  ahead: 0,
  behind: 0,
  entries: [],
  hasConflicts: false,
};

function file(path: string) {
  return {
    oldPath: path,
    newPath: path,
    kind: 'modified' as const,
    binary: false,
    conflicted: false,
    side: 'unstaged' as const,
    headerLines: [],
    hunks: [],
  };
}

describe('actions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    openRepository.mockResolvedValue(REPO);
    getStatus.mockResolvedValue(STATUS);
    readLog.mockResolvedValue([]);
    getWorktreeDiff.mockResolvedValue([]);
    getStagedDiff.mockResolvedValue([]);
    getCommitDiff.mockResolvedValue([]);
    saveConfig.mockResolvedValue(undefined);
    stagePaths.mockResolvedValue(undefined);
    unstagePaths.mockResolvedValue(undefined);
    applyHunks.mockResolvedValue(undefined);
    commit.mockResolvedValue(undefined);
    listBranches.mockResolvedValue([]);
    listStashes.mockResolvedValue([]);
    fetchRemoteFn.mockResolvedValue({
      stdout: '',
      stderr: '',
      code: 0,
      timedOut: false,
      stdoutLossy: false,
    });
    pullFn.mockResolvedValue(undefined);
    pushFn.mockResolvedValue(undefined);
    switchBranch.mockResolvedValue(undefined);
    switchNewBranch.mockResolvedValue(undefined);
    deleteBranch.mockResolvedValue({ deleted: true });
    applyStash.mockResolvedValue(undefined);
    dropStash.mockResolvedValue(undefined);
    discardPaths.mockResolvedValue({
      discarded: true,
      stashLabel: 'krakenless: discarded now',
      undoCommands: ['git restore --source=abc123 --worktree -- "a.txt"'],
      notes: [],
    });
  });

  it('opens a repository and loads every panel', async () => {
    const store = createStore();
    await openRepo(store, 'C:/repos/app');

    const state = store.getState();
    expect(state.repo).toEqual({ state: 'ready', value: REPO });
    expect(state.status.state).toBe('ready');
    expect(state.commits.state).toBe('ready');
    // The working tree is the default selection: leaving the diff idle would
    // read as "this repository has no changes".
    expect(state.diff.state).toBe('ready');
    expect(state.branches.state).toBe('ready');
    expect(state.stashes.state).toBe('ready');
    expect(getStatus).toHaveBeenCalledWith(REPO.root);
  });

  it('records the repository in the recent list under its real root', async () => {
    // The user may pick a subdirectory; the recent entry must be the root git
    // reported, not what was clicked.
    const store = createStore();
    await openRepo(store, 'C:/repos/app/src');

    expect(store.getState().config.recentRepos[0]?.path).toBe(REPO.root);
    expect(saveConfig).toHaveBeenCalledTimes(1);
  });

  it('keeps the repository open when saving the recent list fails', async () => {
    saveConfig.mockRejectedValue(new Error('disk full'));
    const store = createStore();
    await openRepo(store, 'C:/repos/app');
    expect(store.getState().repo.state).toBe('ready');
  });

  it('surfaces the git error kind when opening fails', async () => {
    openRepository.mockRejectedValue(
      new GitError('not-a-repository', 'Not a git repository'),
    );
    const store = createStore();
    await openRepo(store, 'C:/tmp');

    expect(store.getState().repo).toEqual({
      state: 'error',
      message: 'Not a git repository',
      kind: 'not-a-repository',
    });
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('reports a failing status without losing the open repository', async () => {
    getStatus.mockRejectedValue(new GitError('timeout', 'git status timed out'));
    const store = createStore();
    await openRepo(store, 'C:/repos/app');

    expect(store.getState().repo.state).toBe('ready');
    expect(store.getState().status).toMatchObject({ state: 'error', kind: 'timeout' });
  });

  it('loads the working-tree diff when nothing is selected', async () => {
    getWorktreeDiff.mockResolvedValue([file('a.txt')]);
    getStagedDiff.mockResolvedValue([file('b.txt')]);
    const store = createStore();
    await openRepo(store, 'C:/repos/app');
    await refreshDiff(store);

    const diff = store.getState().diff;
    expect(diff.state).toBe('ready');
    expect(diff.state === 'ready' && diff.value.map((f) => f.newPath)).toEqual([
      'a.txt',
      'b.txt',
    ]);
    expect(getCommitDiff).not.toHaveBeenCalled();
  });

  it('loads a commit diff when a commit is selected', async () => {
    const store = createStore();
    await openRepo(store, 'C:/repos/app');
    await selectCommit(store, '9f1c2ab');

    expect(getCommitDiff).toHaveBeenCalledWith(REPO.root, '9f1c2ab');
    expect(store.getState().selection.commitOid).toBe('9f1c2ab');
  });

  it('serves a revisited commit from cache instead of re-running git', async () => {
    // The user's freeze report: a huge commit diff, clicked away from and
    // back, was fetched, transferred and parsed all over again. A commit's
    // diff is immutable, so the second visit must cost nothing.
    getCommitDiff.mockResolvedValue([file('big.lock')]);
    const store = createStore();
    await openRepo(store, 'C:/repos/app');

    await selectCommit(store, '9f1c2ab');
    await selectCommit(store, 'other01');
    await selectCommit(store, '9f1c2ab');

    const commitReads = getCommitDiff.mock.calls.filter((call) => call[1] === '9f1c2ab');
    expect(commitReads.length).toBe(1);
    const diff = store.getState().diff;
    expect(diff.state === 'ready' && diff.value.map((f) => f.newPath)).toEqual([
      'big.lock',
    ]);
  });

  it('never caches the working-tree diff, which is mutable', async () => {
    getWorktreeDiff.mockResolvedValue([file('a.txt')]);
    getStagedDiff.mockResolvedValue([]);
    const store = createStore();
    await openRepo(store, 'C:/repos/app');
    getWorktreeDiff.mockClear();

    await selectCommit(store, null);
    await selectCommit(store, null);

    expect(getWorktreeDiff.mock.calls.length).toBe(2);
  });

  it('drops the diff cache when a repository is opened', async () => {
    getCommitDiff.mockResolvedValue([file('a.txt')]);
    const store = createStore();
    await openRepo(store, 'C:/repos/app');
    await selectCommit(store, '9f1c2ab');
    getCommitDiff.mockClear();

    await openRepo(store, 'C:/repos/app');
    await selectCommit(store, '9f1c2ab');

    expect(getCommitDiff).toHaveBeenCalledTimes(1);
  });

  it('re-reads the status when the working tree is selected', async () => {
    // The status and the diff are two commands answering one question. Reading
    // only the diff is how the working-tree panel ends up saying "clean" beside
    // a diff that lists a modified file.
    const store = createStore();
    await openRepo(store, 'C:/repos/app');
    getStatus.mockClear();

    await selectCommit(store, null);

    expect(getStatus).toHaveBeenCalledWith(REPO.root);
    expect(getWorktreeDiff).toHaveBeenCalled();
  });

  it('does not re-read the status for a commit, which cannot have changed', async () => {
    const store = createStore();
    await openRepo(store, 'C:/repos/app');
    getStatus.mockClear();

    await selectCommit(store, '9f1c2ab');

    expect(getStatus).not.toHaveBeenCalled();
  });

  it('does nothing when no repository is open', async () => {
    const store = createStore();
    await refreshDiff(store);
    expect(getWorktreeDiff).not.toHaveBeenCalled();
    expect(store.getState().diff.state).toBe('idle');
  });

  it('reports an undecodable diff instead of showing a mangled one', async () => {
    getWorktreeDiff.mockRejectedValue(
      new GitError('undecodable-output', 'not valid UTF-8'),
    );
    const store = createStore();
    await openRepo(store, 'C:/repos/app');
    await refreshDiff(store);

    expect(store.getState().diff).toMatchObject({
      state: 'error',
      kind: 'undecodable-output',
    });
  });

  it('forgets a recent repository', async () => {
    const store = createStore();
    await openRepo(store, 'C:/repos/app');
    await forgetRepo(store, REPO.root);
    expect(store.getState().config.recentRepos).toEqual([]);
  });

  it('closing keeps the config and clears the repository', async () => {
    const store = createStore();
    await openRepo(store, 'C:/repos/app');
    closeRepo(store);

    expect(store.getState().repo.state).toBe('idle');
    expect(store.getState().config.recentRepos).toHaveLength(1);
  });

  it('stages paths and refreshes what the change affects', async () => {
    const store = createStore();
    await openRepo(store, 'C:/repos/app');
    getStatus.mockClear();

    await stage(store, ['a.txt']);

    expect(stagePaths).toHaveBeenCalledWith(REPO.root, ['a.txt']);
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(isBusy(store.getState())).toBe(false);
  });

  it('ignores an empty selection instead of staging everything', async () => {
    const store = createStore();
    await openRepo(store, 'C:/repos/app');
    await stage(store, []);
    await unstage(store, []);
    expect(stagePaths).not.toHaveBeenCalled();
    expect(unstagePaths).not.toHaveBeenCalled();
  });

  it('marks the app busy while a write is in flight', async () => {
    let release: () => void = () => {};
    stagePaths.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const store = createStore();
    await openRepo(store, 'C:/repos/app');

    const pending = stage(store, ['a.txt']);
    expect(isBusy(store.getState())).toBe(true);
    release();
    await pending;
    expect(isBusy(store.getState())).toBe(false);
  });

  it('clears busy even when the git command fails', async () => {
    stagePaths.mockRejectedValue(new GitError('command-failed', 'nope'));
    const store = createStore();
    await openRepo(store, 'C:/repos/app');

    await expect(stage(store, ['a.txt'])).rejects.toThrow();
    expect(isBusy(store.getState())).toBe(false);
  });

  it('passes hunk selections through to the patch path', async () => {
    const store = createStore();
    await openRepo(store, 'C:/repos/app');
    const target = file('a.txt');

    await stageHunks(
      store,
      target,
      [{ header: '@@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [] }],
      {
        reverse: false,
      },
    );

    expect(applyHunks).toHaveBeenCalledWith(REPO.root, target, expect.any(Array), {
      reverse: false,
    });
  });

  it('returns the stash label so the UI can explain the undo', async () => {
    const store = createStore();
    await openRepo(store, 'C:/repos/app');

    const result = await discard(store, ['a.txt'], 'Discard changes to a.txt?');

    expect(discardPaths).toHaveBeenCalledWith(
      REPO.root,
      ['a.txt'],
      expect.objectContaining({ reason: 'Discard changes to a.txt?' }),
    );
    expect(result?.stashLabel).toContain('krakenless');
    // The undo route must reach the user, not just the return value. It must
    // be the worktree-only form: `git checkout <oid> -- <path>` would write the
    // index too and clobber the staged snapshot the discard protected.
    expect(store.getState().notice?.undoHint).toContain('git restore --source=');
    expect(store.getState().notice?.undoHint).toContain('--worktree');
  });

  it('offers no undo hint when there is no command to run', async () => {
    // Discarding a deletion stashes something but produces no restore command;
    // an empty hint would render as "Run this to undo:" above nothing.
    discardPaths.mockResolvedValue({
      discarded: true,
      stashLabel: 'krakenless: deletion',
      undoCommands: [],
      notes: ['The stash abc123 also holds "a.txt", which this command cannot restore.'],
    });
    const store = createStore();
    await openRepo(store, 'C:/repos/app');

    await discard(store, ['a.txt'], 'Discard?');

    expect(store.getState().notice?.undoHint).toBeUndefined();
    expect(store.getState().notice?.message).toContain('cannot restore');
  });

  it('says nothing was discarded when git created no stash', async () => {
    // `stash push -- <path>` exits 0 and creates nothing when the path is
    // unchanged; claiming success would send the user to an unrelated stash.
    listBranches.mockResolvedValue([]);
    listStashes.mockResolvedValue([]);
    fetchRemoteFn.mockResolvedValue({
      stdout: '',
      stderr: '',
      code: 0,
      timedOut: false,
      stdoutLossy: false,
    });
    pullFn.mockResolvedValue(undefined);
    pushFn.mockResolvedValue(undefined);
    switchBranch.mockResolvedValue(undefined);
    switchNewBranch.mockResolvedValue(undefined);
    deleteBranch.mockResolvedValue({ deleted: true });
    applyStash.mockResolvedValue(undefined);
    dropStash.mockResolvedValue(undefined);
    discardPaths.mockResolvedValue({ discarded: false, undoCommands: [] });
    const store = createStore();
    await openRepo(store, 'C:/repos/app');

    await discard(store, ['a.txt'], 'Discard changes to a.txt?');

    expect(store.getState().notice).toMatchObject({ tone: 'warning' });
    expect(store.getState().notice?.undoHint).toBeUndefined();
  });

  it('reports a discard that failed after stashing, with its recovery route', async () => {
    // The file is already off disk at this point; swallowing the error would
    // leave the user with no idea where their work went.
    discardPaths.mockRejectedValue(
      new GitError(
        'command-failed',
        'The discard failed partway. Your changes are in a stash: git restore --source=abc --worktree -- "a.txt"',
      ),
    );
    const store = createStore();
    await openRepo(store, 'C:/repos/app');

    // Rethrown, not swallowed: a caller that read `null` as "nothing happened"
    // would tell the user there is nothing to recover while a stash holds it.
    await expect(discard(store, ['a.txt'], 'Discard?')).rejects.toThrow(/stash/);
    expect(store.getState().notice).toMatchObject({ tone: 'error' });
    expect(store.getState().notice?.message).toContain('git restore --source=');
    expect(isBusy(store.getState())).toBe(false);
  });

  it('refreshes the history after committing', async () => {
    const store = createStore();
    await openRepo(store, 'C:/repos/app');
    readLog.mockClear();

    await commitStaged(store, { message: 'feat: thing' });

    expect(commit).toHaveBeenCalledWith(REPO.root, { message: 'feat: thing' });
    expect(readLog).toHaveBeenCalled();
  });

  it('reports a failed pull as a notice instead of throwing at the view', async () => {
    pullFn.mockRejectedValue(
      new GitError('command-failed', 'Your branch and its upstream have diverged.'),
    );
    const store = createStore();
    await openRepo(store, 'C:/repos/app');

    await expect(pullCurrent(store)).resolves.toBe(false);
    expect(store.getState().notice).toMatchObject({ tone: 'error' });
    expect(store.getState().notice?.message).toContain('diverged');
  });

  it('refreshes everything after a fetch, including branches and stashes', async () => {
    readRefSnapshot.mockResolvedValue(new Map());
    const store = createStore();
    await openRepo(store, 'C:/repos/app');
    listBranches.mockClear();
    listStashes.mockClear();

    await expect(fetchRemote(store)).resolves.toBe(true);

    expect(fetchRemoteFn).toHaveBeenCalledWith(REPO.root, { prune: true });
    expect(listBranches).toHaveBeenCalled();
    expect(listStashes).toHaveBeenCalled();
    expect(isBusy(store.getState())).toBe(false);
  });

  it('says what a fetch brought back, tags included', async () => {
    // Without this the button is indistinguishable from a broken one: nothing
    // on screen moves when the news is a tag.
    readRefSnapshot
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(new Map([['refs/tags/v1.0', 'a'.repeat(40)]]));
    const store = createStore();
    await openRepo(store, 'C:/repos/app');

    await expect(fetchRemote(store)).resolves.toBe(true);
    expect(store.getState().notice).toMatchObject({
      tone: 'info',
      message: 'Fetched: 1 new tag (v1.0).',
    });
  });

  it('says so plainly when a fetch brought nothing', async () => {
    const same = new Map([['refs/remotes/origin/main', 'b'.repeat(40)]]);
    readRefSnapshot.mockResolvedValue(same);
    const store = createStore();
    await openRepo(store, 'C:/repos/app');

    await expect(fetchRemote(store)).resolves.toBe(true);
    expect(store.getState().notice?.message).toBe('Fetched: nothing new.');
  });

  it('reports a failed fetch as the error it is, with no success line over it', async () => {
    readRefSnapshot.mockResolvedValue(new Map());
    fetchRemoteFn.mockRejectedValue(
      new GitError('command-failed', 'Could not resolve host'),
    );
    const store = createStore();
    await openRepo(store, 'C:/repos/app');

    await expect(fetchRemote(store)).resolves.toBe(false);
    expect(store.getState().notice).toMatchObject({ tone: 'error' });
  });

  it('keeps the panels consistent when a branch switch fails', async () => {
    // A failed switch leaves the old branch checked out; the panels must be
    // re-read rather than left showing the branch the user tried to reach.
    switchBranch.mockRejectedValue(new GitError('command-failed', 'local changes'));
    const store = createStore();
    await openRepo(store, 'C:/repos/app');
    getStatus.mockClear();

    await expect(switchTo(store, 'topic')).resolves.toBe(false);
    expect(getStatus).toHaveBeenCalled();
    expect(store.getState().notice).toMatchObject({ tone: 'error' });
  });

  it('surfaces the unmerged warning instead of deleting', async () => {
    deleteBranch.mockResolvedValue({
      deleted: false,
      unmergedWarning: 'Branch "topic" has commits that are not merged anywhere.',
    });
    const store = createStore();
    await openRepo(store, 'C:/repos/app');

    const outcome = await removeBranch(store, 'topic', 'Delete branch topic?');

    expect(outcome?.deleted).toBe(false);
    expect(store.getState().notice).toMatchObject({ tone: 'warning' });
  });

  it('passes the confirmation the user saw down to the stash drop', async () => {
    const store = createStore();
    await openRepo(store, 'C:/repos/app');

    await removeStash(store, { ref: 'stash@{0}', oid: 'abc' }, 'Drop stash@{0}?');

    expect(dropStash).toHaveBeenCalledWith(
      REPO.root,
      { ref: 'stash@{0}', oid: 'abc' },
      expect.objectContaining({ reason: 'Drop stash@{0}?' }),
    );
  });
});

describe('undoDiscard', () => {
  const ORIGINAL = 'the original bytes\n';
  const BACKUP = {
    path: 'src/a.ts',
    blobOid: 'a'.repeat(40),
    at: '2026-08-31T10:00:00.000Z',
  };

  beforeEach(() => {
    readBackupBlob.mockResolvedValue(ORIGINAL);
    openWorktreeFile.mockResolvedValue({
      path: 'src/a.ts',
      text: '',
      shape: {},
      stamp: 'stamp',
    });
    saveWorktreeFile.mockResolvedValue(undefined);
  });

  async function opened() {
    const store = createStore();
    await openRepo(store, 'C:/repos/app');
    store.dispatch({ type: 'discard/recorded', backup: BACKUP });
    return store;
  }

  it('writes the blob back verbatim through the app, not a shell redirect', async () => {
    const store = await opened();

    await undoDiscard(store, BACKUP);

    expect(readBackupBlob).toHaveBeenCalledWith(REPO.root, BACKUP.blobOid);
    // Exactly what came out of the object store: `saveWorktreeFile` reformats
    // nothing, so line endings and a missing final newline survive.
    expect(saveWorktreeFile).toHaveBeenCalledWith(
      REPO.root,
      expect.objectContaining({ path: 'src/a.ts' }),
      ORIGINAL,
    );
    expect(store.getState().discards).toEqual([]);
  });

  it('keeps the backup listed when the restore fails', async () => {
    // Dropping the record on a failed restore would throw away the oid that is
    // still the only way back to the discarded work.
    saveWorktreeFile.mockRejectedValue(new GitError('command-failed', 'disk full'));
    const store = await opened();

    await undoDiscard(store, BACKUP);

    expect(store.getState().discards).toEqual([BACKUP]);
    expect(store.getState().notice?.tone).toBe('error');
  });
});

describe('refreshDiff — a stale answer never lands behind a newer selection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    openRepository.mockResolvedValue(REPO);
    getStatus.mockResolvedValue(STATUS);
    readLog.mockResolvedValue([]);
    getWorktreeDiff.mockResolvedValue([file('worktree.txt')]);
    getStagedDiff.mockResolvedValue([]);
    saveConfig.mockResolvedValue(undefined);
    listBranches.mockResolvedValue([]);
    listStashes.mockResolvedValue([]);
  });

  it('drops a slow commit diff that resolves after the user moved on', async () => {
    // The freeze scenario made this deterministic: a huge commit diff takes
    // seconds, and a click on a cached commit (or the working tree) answers
    // instantly. The late result must not overwrite what the user is looking
    // at — with the wrong side's action buttons attached to it.
    let resolveSlow: (files: unknown) => void = () => {};
    getCommitDiff.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSlow = resolve;
      }),
    );
    const store = createStore();
    await openRepo(store, 'C:/repos/app');

    const slow = selectCommit(store, 'slowoid');
    await selectCommit(store, null);
    resolveSlow([file('huge.lock')]);
    await slow;

    const diff = store.getState().diff;
    expect(diff.state === 'ready' && diff.value.map((f) => f.newPath)).toEqual([
      'worktree.txt',
    ]);
  });

  it('drops a slow worktree diff that resolves after a commit was selected', async () => {
    let resolveSlow: (files: unknown) => void = () => {};
    getCommitDiff.mockResolvedValue([file('committed.txt')]);
    const store = createStore();
    await openRepo(store, 'C:/repos/app');
    // Armed only now: openRepo runs its own refreshDiff, which must not eat
    // the one slow answer this test is about.
    getWorktreeDiff.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSlow = resolve;
      }),
    );

    const slow = refreshDiff(store);
    await selectCommit(store, '9f1c2ab');
    resolveSlow([file('worktree.txt')]);
    await slow;

    const diff = store.getState().diff;
    expect(diff.state === 'ready' && diff.value.map((f) => f.newPath)).toEqual([
      'committed.txt',
    ]);
  });
});
