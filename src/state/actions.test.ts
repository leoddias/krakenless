import { beforeEach, describe, expect, it, vi } from 'vitest';
import { closeRepo, forgetRepo, openRepo, refreshDiff, selectCommit } from './actions';
import { createStore } from './store';
import { GitError } from '../git/errors';

const openRepository = vi.hoisted(() => vi.fn());
const getStatus = vi.hoisted(() => vi.fn());
const readLog = vi.hoisted(() => vi.fn());
const getWorktreeDiff = vi.hoisted(() => vi.fn());
const getStagedDiff = vi.hoisted(() => vi.fn());
const getCommitDiff = vi.hoisted(() => vi.fn());
const saveConfig = vi.hoisted(() => vi.fn());

vi.mock('../git/repository', () => ({ openRepository }));
vi.mock('../git/status', () => ({ getStatus }));
vi.mock('../git/log', () => ({ readLog }));
vi.mock('../git/diff', () => ({ getWorktreeDiff, getStagedDiff, getCommitDiff }));
vi.mock('../config/store', () => ({ saveConfig }));

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
});
