import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIRST_FETCH_DELAY_MS, runFetch, startAutoFetch } from './autoFetch';
import { createStore, type Store } from './store';

const gitFetch = vi.hoisted(() => vi.fn());
const readRefSnapshot = vi.hoisted(() => vi.fn());
const refreshBranches = vi.hoisted(() => vi.fn());
const refreshCommits = vi.hoisted(() => vi.fn());
const refreshStatus = vi.hoisted(() => vi.fn());
const refreshRemotes = vi.hoisted(() => vi.fn());

// The change detection in `fetchNews` is exercised for real here: what the
// schedule does depends entirely on whether a ref moved, so stubbing that out
// would leave the interesting half of this module untested.
vi.mock('../git/refs', () => ({ fetch: gitFetch, readRefSnapshot }));
vi.mock('./actions', () => ({
  refreshBranches,
  refreshCommits,
  refreshStatus,
  refreshRemotes,
}));

const ROOT = 'C:/repos/app';

/** A store with a repository open and one remote, the ordinary case. */
function openStore(): Store {
  const store = createStore();
  store.dispatch({
    type: 'repo/opened',
    repo: { root: ROOT, gitDir: `${ROOT}/.git`, bare: false, empty: false },
  });
  store.dispatch({
    type: 'remotes/loaded',
    remotes: [
      { name: 'origin', fetchUrl: 'git@host:app.git', pushUrl: 'git@host:app.git' },
    ],
  });
  return store;
}

/** What the runner hands back: a fetch reports its refusals on stderr. */
function gitOutput(stderr = '') {
  return { stdout: '', stderr, code: 0, timedOut: false, stdoutLossy: false };
}

const OLD = '1111111111111111111111111111111111111111';
const NEW = '2222222222222222222222222222222222222222';

/** Ref snapshots for "somebody pushed to origin/main while we were away". */
function movedRefs(): void {
  readRefSnapshot
    .mockResolvedValueOnce(new Map([['refs/remotes/origin/main', OLD]]))
    .mockResolvedValueOnce(new Map([['refs/remotes/origin/main', NEW]]));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  gitFetch.mockResolvedValue(gitOutput());
  // The default for the schedule tests: every fetch brings something, so a
  // missing refresh is a defect rather than the no-news short circuit. Counted
  // rather than random — the values are never asserted on, and a random one
  // reads as if it were.
  let moves = 0;
  readRefSnapshot.mockImplementation(() =>
    Promise.resolve(
      new Map([['refs/remotes/origin/main', String(++moves).padStart(40, '0')]]),
    ),
  );
  refreshBranches.mockResolvedValue(undefined);
  refreshCommits.mockResolvedValue(undefined);
  refreshStatus.mockResolvedValue(undefined);
  refreshRemotes.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runFetch', () => {
  it('fetches with prune and reloads what a fetch can move', async () => {
    await runFetch(openStore(), ROOT);

    expect(gitFetch).toHaveBeenCalledWith(ROOT, { prune: true });
    expect(refreshBranches).toHaveBeenCalledTimes(1);
    expect(refreshCommits).toHaveBeenCalledTimes(1);
    expect(refreshStatus).toHaveBeenCalledTimes(1);
    expect(refreshRemotes).toHaveBeenCalledTimes(1);
  });

  it('stays out of the way while a git operation is running', async () => {
    const store = openStore();
    store.dispatch({ type: 'busy', busy: true });

    await runFetch(store, ROOT);

    // Two git processes writing `.git/` at once is a class of problem worth
    // never having, and the operation refreshes everything when it lands.
    expect(gitFetch).not.toHaveBeenCalled();
  });

  it('does not run against a repository with no remote', async () => {
    const store = createStore();
    store.dispatch({
      type: 'repo/opened',
      repo: { root: ROOT, gitDir: `${ROOT}/.git`, bare: false, empty: false },
    });
    store.dispatch({ type: 'remotes/loaded', remotes: [] });

    await runFetch(store, ROOT);
    expect(gitFetch).not.toHaveBeenCalled();
  });

  it('says nothing when the fetch fails', async () => {
    // Offline, VPN down, key not unlocked: ordinary states for a machine to be
    // in, and none of them news the user asked for.
    gitFetch.mockRejectedValue(new Error('Could not resolve host'));
    const store = openStore();

    await expect(runFetch(store, ROOT)).resolves.toBeUndefined();
    expect(store.getState().notice).toBeNull();
    expect(refreshBranches).not.toHaveBeenCalled();
  });

  it('re-reads the status even while the fetch keeps failing', async () => {
    // A laptop off-network all afternoon still has a user committing in a
    // terminal, and a working-tree panel that never updates again is the same
    // stale row somebody clicks Discard on.
    gitFetch.mockRejectedValue(new Error('Could not resolve host'));

    await runFetch(openStore(), ROOT);

    expect(refreshStatus).toHaveBeenCalledTimes(1);
  });

  it('never marks the app busy, so no click is lost under it', async () => {
    const store = openStore();
    let busyDuringFetch = false;
    gitFetch.mockImplementation(() => {
      busyDuringFetch = store.getState().busyDepth > 0;
      return Promise.resolve(gitOutput());
    });

    await runFetch(store, ROOT);
    expect(busyDuringFetch).toBe(false);
    expect(store.getState().busyDepth).toBe(0);
  });

  it('drops the refresh when the schedule was stopped mid-fetch', async () => {
    await runFetch(openStore(), ROOT, () => true);

    expect(gitFetch).toHaveBeenCalledTimes(1);
    expect(refreshBranches).not.toHaveBeenCalled();
  });

  it('leaves every panel alone when no ref moved', async () => {
    // The common case, twelve times an hour, forever. Reloading four panels to
    // redraw identical numbers costs four git processes and can blank a list
    // under the user's cursor.
    const same = new Map([['refs/remotes/origin/main', OLD]]);
    readRefSnapshot.mockResolvedValue(same);
    const store = openStore();

    await runFetch(store, ROOT);

    expect(gitFetch).toHaveBeenCalledTimes(1);
    expect(refreshBranches).not.toHaveBeenCalled();
    expect(refreshCommits).not.toHaveBeenCalled();
    expect(store.getState().notice).toBeNull();
  });

  it('still re-reads the status when no ref moved', async () => {
    // A commit made in a terminal moves no remote ref, and the snapshot cannot
    // see it, so this must not hide behind the change check.
    readRefSnapshot.mockResolvedValue(new Map([['refs/remotes/origin/main', OLD]]));

    await runFetch(openStore(), ROOT);

    expect(refreshStatus).toHaveBeenCalledTimes(1);
    expect(refreshBranches).not.toHaveBeenCalled();
  });

  it('refreshes and says what arrived when a ref moved', async () => {
    movedRefs();
    const store = openStore();

    await runFetch(store, ROOT);

    expect(refreshBranches).toHaveBeenCalledTimes(1);
    expect(store.getState().notice).toMatchObject({
      tone: 'info',
      message: 'Fetched: 1 branch updated (origin/main).',
    });
  });

  it('names a tag that arrived, which is the news nothing else reports', async () => {
    readRefSnapshot
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(new Map([['refs/tags/v1.0', NEW]]));
    const store = openStore();

    await runFetch(store, ROOT);

    expect(store.getState().notice?.message).toBe('Fetched: 1 new tag (v1.0).');
  });

  it('refreshes but keeps quiet over an error the user still needs', async () => {
    movedRefs();
    const store = openStore();
    store.dispatch({
      type: 'notice',
      notice: { tone: 'error', message: 'Push rejected: fetch first.' },
    });

    await runFetch(store, ROOT);

    expect(refreshBranches).toHaveBeenCalledTimes(1);
    expect(store.getState().notice?.message).toBe('Push rejected: fetch first.');
  });

  it('refreshes anyway when it cannot tell what changed', async () => {
    readRefSnapshot.mockRejectedValue(new Error('for-each-ref failed'));
    const store = openStore();

    await runFetch(store, ROOT);

    // Not knowing is a reason to re-read, never a reason to claim nothing
    // happened — but it is not something to announce either.
    expect(refreshBranches).toHaveBeenCalledTimes(1);
    expect(store.getState().notice).toBeNull();
  });
});

describe('startAutoFetch', () => {
  it('starts nothing at all when the setting is off', async () => {
    const handle = startAutoFetch(openStore(), ROOT, 0);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(gitFetch).not.toHaveBeenCalled();
    await handle.stop();
  });

  it('fetches shortly after the repository opens, then on the interval', async () => {
    const handle = startAutoFetch(openStore(), ROOT, 5);

    // Not immediately: opening a repository already runs several git commands,
    // and the panels should not queue behind a network round trip.
    expect(gitFetch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(FIRST_FETCH_DELAY_MS);
    expect(gitFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(gitFetch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(gitFetch).toHaveBeenCalledTimes(3);
    await handle.stop();
  });

  it('waits a whole interval between fetches even when one is slow', async () => {
    let release: () => void = () => {};
    gitFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(gitOutput());
        }),
    );
    const handle = startAutoFetch(openStore(), ROOT, 1);

    await vi.advanceTimersByTimeAsync(FIRST_FETCH_DELAY_MS);
    expect(gitFetch).toHaveBeenCalledTimes(1);

    // The remote takes longer than the interval. A missed tick must not be
    // made up for afterwards, or a slow remote gets a burst of fetches.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(gitFetch).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(gitFetch).toHaveBeenCalledTimes(2);

    // `stop` waits for the fetch in flight, so the second one has to land
    // before the schedule can be torn down.
    release();
    await handle.stop();
  });

  it('stops fetching once the repository is closed', async () => {
    const handle = startAutoFetch(openStore(), ROOT, 1);
    await vi.advanceTimersByTimeAsync(FIRST_FETCH_DELAY_MS);
    expect(gitFetch).toHaveBeenCalledTimes(1);

    await handle.stop();

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(gitFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps its schedule after a tick fails outright', async () => {
    // A rejected tick used to be chained onto: every later fetch waited on a
    // promise that would never settle, so one bad refresh silently ended
    // background fetching for the life of the window.
    refreshBranches.mockRejectedValueOnce(new Error('panel blew up'));
    const handle = startAutoFetch(openStore(), ROOT, 1);

    await vi.advanceTimersByTimeAsync(FIRST_FETCH_DELAY_MS);
    expect(gitFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(gitFetch).toHaveBeenCalledTimes(2);

    await handle.stop();
  });

  it('does not wait longer than the interval for the first fetch', async () => {
    // A one-minute interval must not be delayed by a longer opening delay.
    const handle = startAutoFetch(openStore(), ROOT, 1);
    await vi.advanceTimersByTimeAsync(FIRST_FETCH_DELAY_MS);
    expect(gitFetch).toHaveBeenCalledTimes(1);
    await handle.stop();
  });
});
