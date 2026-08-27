import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIRST_FETCH_DELAY_MS, runFetch, startAutoFetch } from './autoFetch';
import { createStore, type Store } from './store';

const gitFetch = vi.hoisted(() => vi.fn());
const refreshBranches = vi.hoisted(() => vi.fn());
const refreshCommits = vi.hoisted(() => vi.fn());
const refreshStatus = vi.hoisted(() => vi.fn());
const refreshRemotes = vi.hoisted(() => vi.fn());

vi.mock('../git/refs', () => ({ fetch: gitFetch }));
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  gitFetch.mockResolvedValue(undefined);
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

  it('never marks the app busy, so no click is lost under it', async () => {
    const store = openStore();
    let busyDuringFetch = false;
    gitFetch.mockImplementation(() => {
      busyDuringFetch = store.getState().busyDepth > 0;
      return Promise.resolve(undefined);
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
        new Promise<void>((resolve) => {
          release = resolve;
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

  it('does not wait longer than the interval for the first fetch', async () => {
    // A one-minute interval must not be delayed by a longer opening delay.
    const handle = startAutoFetch(openStore(), ROOT, 1);
    await vi.advanceTimersByTimeAsync(FIRST_FETCH_DELAY_MS);
    expect(gitFetch).toHaveBeenCalledTimes(1);
    await handle.stop();
  });
});
