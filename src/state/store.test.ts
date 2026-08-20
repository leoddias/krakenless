import { describe, expect, it, vi } from 'vitest';
import { createStore, initialState, reduce } from './store';
import type { AppState } from './store';
import type { Commit, RepoInfo, RepoStatus } from '../git/types';

const REPO: RepoInfo = {
  root: 'C:/repos/app',
  gitDir: 'C:/repos/app/.git',
  bare: false,
  empty: false,
};

const STATUS: RepoStatus = {
  branch: 'main',
  head: '9f1c2ab',
  detached: false,
  ahead: 0,
  behind: 0,
  entries: [],
  hasConflicts: false,
};

function commit(oid: string): Commit {
  return {
    oid,
    shortOid: oid.slice(0, 7),
    parents: [],
    authorName: 'A',
    authorEmail: 'a@example.com',
    authorDate: '2026-08-19T10:00:00+00:00',
    committerName: 'A',
    committerDate: '2026-08-19T10:00:00+00:00',
    subject: 'subject',
    body: '',
    refs: [],
  };
}

function loaded(): AppState {
  let state = reduce(initialState(), { type: 'repo/opened', repo: REPO });
  state = reduce(state, { type: 'status/loaded', status: STATUS });
  state = reduce(state, { type: 'commits/loaded', commits: [commit('9f1c2ab')] });
  return state;
}

describe('reduce', () => {
  it('starts every panel idle', () => {
    const state = initialState();
    expect(state.repo.state).toBe('idle');
    expect(state.status.state).toBe('idle');
    expect(state.commits.state).toBe('idle');
    expect(state.diff.state).toBe('idle');
  });

  it('carries an error message and kind so the UI can be specific', () => {
    const state = reduce(initialState(), {
      type: 'repo/failed',
      message: 'Not a git repository',
      kind: 'not-a-repository',
    });
    expect(state.repo).toEqual({
      state: 'error',
      message: 'Not a git repository',
      kind: 'not-a-repository',
    });
  });

  it('clears everything derived from the previous repository', () => {
    // Showing the old repo's commits under the new repo's name would be a lie
    // the user could act on.
    const next = reduce(loaded(), {
      type: 'repo/opened',
      repo: { ...REPO, root: 'C:/other' },
    });
    expect(next.status.state).toBe('idle');
    expect(next.commits.state).toBe('idle');
    expect(next.diff.state).toBe('idle');
    expect(next.selection).toEqual({ commitOid: null, path: null });
  });

  it('keeps the loaded config across repository changes', () => {
    const withConfig = reduce(loaded(), {
      type: 'config/loaded',
      config: { ...initialState().config, editorCommand: 'code -g' },
    });
    expect(reduce(withConfig, { type: 'repo/closed' }).config.editorCommand).toBe(
      'code -g',
    );
  });

  it('drops the diff when the selection changes', () => {
    let state = reduce(loaded(), { type: 'diff/loaded', files: [] });
    expect(state.diff.state).toBe('ready');
    state = reduce(state, { type: 'selection/commit', oid: '9f1c2ab' });
    expect(state.diff.state).toBe('idle');
    expect(state.selection).toEqual({ commitOid: '9f1c2ab', path: null });
  });

  it('resets the selected path when the selected commit changes', () => {
    let state = reduce(loaded(), { type: 'selection/path', path: 'src/app.ts' });
    state = reduce(state, { type: 'selection/commit', oid: 'abc1234' });
    expect(state.selection.path).toBeNull();
  });

  it('tracks the busy flag independently of panel state', () => {
    const state = reduce(loaded(), { type: 'busy', busy: true });
    expect(state.busy).toBe(true);
    expect(state.status.state).toBe('ready');
  });

  it('never mutates the previous state', () => {
    const before = loaded();
    const snapshot = JSON.stringify(before);
    reduce(before, { type: 'status/loading' });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('createStore', () => {
  it('notifies subscribers on change', () => {
    const store = createStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.dispatch({ type: 'repo/opened', repo: REPO });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState().repo).toEqual({ state: 'ready', value: REPO });
  });

  it('stops notifying after unsubscribe', () => {
    const store = createStore();
    const listener = vi.fn();
    store.subscribe(listener)();
    store.dispatch({ type: 'busy', busy: true });
    expect(listener).not.toHaveBeenCalled();
  });

  it('survives a subscriber that unsubscribes during notification', () => {
    const store = createStore();
    const second = vi.fn();
    const stop = store.subscribe(() => stop());
    store.subscribe(second);

    store.dispatch({ type: 'busy', busy: true });
    expect(second).toHaveBeenCalledTimes(1);
  });
});
