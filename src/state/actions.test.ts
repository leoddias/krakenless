import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeRepo,
  commitStaged,
  discard,
  forgetRepo,
  openRepo,
  refreshDiff,
  selectCommit,
  stage,
  stageHunks,
  unstage,
} from './actions';
import { createStore } from './store';
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

vi.mock('../git/repository', () => ({ openRepository }));
vi.mock('../git/status', () => ({ getStatus }));
vi.mock('../git/log', () => ({ readLog }));
vi.mock('../git/diff', () => ({ getWorktreeDiff, getStagedDiff, getCommitDiff }));
vi.mock('../config/store', () => ({ saveConfig }));
vi.mock('../git/stage', () => ({
  stagePaths,
  unstagePaths,
  applyHunks,
  commit,
  discardPaths,
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
    discardPaths.mockResolvedValue({
      discarded: true,
      stashLabel: 'krakenless: discarded now',
      undoCommands: ['git checkout abc123 -- "a.txt"'],
    });
  });

  it('opens a repository and loads status and history', async () => {
    const store = createStore();
    await openRepo(store, 'C:/repos/app');

    const state = store.getState();
    expect(state.repo).toEqual({ state: 'ready', value: REPO });
    expect(state.status.state).toBe('ready');
    expect(state.commits.state).toBe('ready');
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
    expect(store.getState().busy).toBe(false);
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
    expect(store.getState().busy).toBe(true);
    release();
    await pending;
    expect(store.getState().busy).toBe(false);
  });

  it('clears busy even when the git command fails', async () => {
    stagePaths.mockRejectedValue(new GitError('command-failed', 'nope'));
    const store = createStore();
    await openRepo(store, 'C:/repos/app');

    await expect(stage(store, ['a.txt'])).rejects.toThrow();
    expect(store.getState().busy).toBe(false);
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

    const result = await discard(
      store,
      { tracked: ['a.txt'], untracked: [] },
      'Discard changes to a.txt?',
    );

    expect(discardPaths).toHaveBeenCalledWith(
      REPO.root,
      { tracked: ['a.txt'], untracked: [] },
      expect.objectContaining({ reason: 'Discard changes to a.txt?' }),
    );
    expect(result?.stashLabel).toContain('krakenless');
    // The undo route must reach the user, not just the return value.
    expect(store.getState().notice?.undoHint).toContain('git checkout');
  });

  it('says nothing was discarded when git created no stash', async () => {
    // `stash push -- <path>` exits 0 and creates nothing when the path is
    // unchanged; claiming success would send the user to an unrelated stash.
    discardPaths.mockResolvedValue({ discarded: false, undoCommands: [] });
    const store = createStore();
    await openRepo(store, 'C:/repos/app');

    await discard(
      store,
      { tracked: ['a.txt'], untracked: [] },
      'Discard changes to a.txt?',
    );

    expect(store.getState().notice).toMatchObject({ tone: 'warning' });
    expect(store.getState().notice?.undoHint).toBeUndefined();
  });

  it('refreshes the history after committing', async () => {
    const store = createStore();
    await openRepo(store, 'C:/repos/app');
    readLog.mockClear();

    await commitStaged(store, { message: 'feat: thing' });

    expect(commit).toHaveBeenCalledWith(REPO.root, { message: 'feat: thing' });
    expect(readLog).toHaveBeenCalled();
  });
});
