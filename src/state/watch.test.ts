import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFRESH_DELAY_MS, REPO_CHANGED_EVENT, watchRepository } from './watch';
import { createStore } from './store';

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
const refreshStatus = vi.hoisted(() => vi.fn());
const refreshCommits = vi.hoisted(() => vi.fn());
const refreshDiff = vi.hoisted(() => vi.fn());
const refreshBranches = vi.hoisted(() => vi.fn());
const refreshRemotes = vi.hoisted(() => vi.fn());
const refreshStashes = vi.hoisted(() => vi.fn());
const refreshWorktrees = vi.hoisted(() => vi.fn());
const refreshOperation = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));
vi.mock('./actions', () => ({
  refreshStatus,
  refreshCommits,
  refreshDiff,
  refreshBranches,
  refreshRemotes,
  refreshStashes,
  refreshWorktrees,
  refreshOperation,
}));

/** Fires the repo-changed event as Tauri delivers it: payload = watch token. */
let emit: (token?: number) => void;
let unlisten: ReturnType<typeof vi.fn>;

describe('watchRepository', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    unlisten = vi.fn();
    // `watch_repo` answers with the token that identifies the watch.
    invoke.mockImplementation((command: string) =>
      Promise.resolve(command === 'watch_repo' ? 7 : undefined),
    );
    listen.mockImplementation(
      (_event: string, handler: (event: { payload: number }) => void) => {
        emit = (token = 7) => handler({ payload: token });
        return Promise.resolve(unlisten);
      },
    );
    refreshStatus.mockResolvedValue(undefined);
    refreshCommits.mockResolvedValue(undefined);
    refreshDiff.mockResolvedValue(undefined);
    refreshBranches.mockResolvedValue(undefined);
    refreshRemotes.mockResolvedValue(undefined);
    refreshStashes.mockResolvedValue(undefined);
    refreshWorktrees.mockResolvedValue(undefined);
    refreshOperation.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts the Rust watcher for the repository root', async () => {
    await watchRepository(createStore(), 'C:/repos/app');
    expect(listen).toHaveBeenCalledWith(REPO_CHANGED_EVENT, expect.any(Function));
    expect(invoke).toHaveBeenCalledWith('watch_repo', { path: 'C:/repos/app' });
  });

  it('refreshes every panel after a change settles', async () => {
    await watchRepository(createStore(), 'C:/repos/app');
    emit();
    expect(refreshStatus).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS);
    expect(refreshStatus).toHaveBeenCalledTimes(1);
    expect(refreshCommits).toHaveBeenCalledTimes(1);
    expect(refreshDiff).toHaveBeenCalledTimes(1);
    // A branch, a commit or a stash made from a terminal moves refs without
    // touching a tracked file: the ref-reading panels have to reload too, or
    // they keep showing a repository that has already moved on.
    expect(refreshBranches).toHaveBeenCalledTimes(1);
    expect(refreshRemotes).toHaveBeenCalledTimes(1);
    expect(refreshStashes).toHaveBeenCalledTimes(1);
    expect(refreshWorktrees).toHaveBeenCalledTimes(1);
    // A rebase advancing or being finished from a terminal touches `.git` and
    // nothing else; this refresh is the only thing that notices.
    expect(refreshOperation).toHaveBeenCalledTimes(1);
  });

  it('collapses a burst of events into one refresh', async () => {
    // A rebase emits many bursts; refreshing per burst keeps git busy against
    // a repository that is still changing.
    await watchRepository(createStore(), 'C:/repos/app');
    for (let i = 0; i < 20; i += 1) emit();

    await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS);
    expect(refreshStatus).toHaveBeenCalledTimes(1);
  });

  it('does not overlap refreshes', async () => {
    let release: () => void = () => {};
    refreshStatus.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    await watchRepository(createStore(), 'C:/repos/app');
    emit();
    await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS);
    emit();
    await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS);

    // The second refresh waits for the first to finish.
    expect(refreshStatus).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshStatus).toHaveBeenCalledTimes(2);
  });

  it('stops listening and refreshing after stop', async () => {
    const handle = await watchRepository(createStore(), 'C:/repos/app');
    await handle.stop();

    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('unwatch_repo', { token: 7 });

    emit();
    await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS * 4);
    expect(refreshStatus).not.toHaveBeenCalled();
  });

  it('cancels a pending refresh when stopped mid-debounce', async () => {
    const handle = await watchRepository(createStore(), 'C:/repos/app');
    emit();
    await handle.stop();

    await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS * 4);
    expect(refreshStatus).not.toHaveBeenCalled();
  });

  it('survives unwatch failing', async () => {
    const handle = await watchRepository(createStore(), 'C:/repos/app');
    invoke.mockRejectedValueOnce(new Error('nothing to unwatch'));
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it('stops the watch it started, not whichever one is current', async () => {
    // Two watches overlap whenever the effect that owns them re-runs — React's
    // StrictMode does exactly that on every mount in development. Without the
    // token, the first teardown tears down the *second* watch, and the app is
    // then blind to every change made outside it.
    let next = 1;
    invoke.mockImplementation((command: string) =>
      Promise.resolve(command === 'watch_repo' ? next++ : undefined),
    );

    const first = await watchRepository(createStore(), 'C:/repos/app');
    const second = await watchRepository(createStore(), 'C:/repos/app');
    await first.stop();

    expect(invoke).toHaveBeenCalledWith('unwatch_repo', { token: 1 });
    expect(invoke).not.toHaveBeenCalledWith('unwatch_repo', { token: 2 });

    await second.stop();
    expect(invoke).toHaveBeenCalledWith('unwatch_repo', { token: 2 });
  });

  it('ignores a change in another open repository', async () => {
    // One event channel serves every watch in the process. Without the token,
    // a change in one tab would re-read every panel of every other tab.
    await watchRepository(createStore(), 'C:/repos/app');

    emit(999);
    await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS * 2);
    expect(refreshStatus).not.toHaveBeenCalled();

    emit(7);
    await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS * 2);
    expect(refreshStatus).toHaveBeenCalledTimes(1);
  });
});
