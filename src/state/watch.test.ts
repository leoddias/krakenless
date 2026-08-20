import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFRESH_DELAY_MS, REPO_CHANGED_EVENT, watchRepository } from './watch';
import { createStore } from './store';

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
const refreshStatus = vi.hoisted(() => vi.fn());
const refreshCommits = vi.hoisted(() => vi.fn());
const refreshDiff = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));
vi.mock('./actions', () => ({ refreshStatus, refreshCommits, refreshDiff }));

let emit: () => void;
let unlisten: ReturnType<typeof vi.fn>;

describe('watchRepository', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    unlisten = vi.fn();
    invoke.mockResolvedValue(undefined);
    listen.mockImplementation((_event: string, handler: () => void) => {
      emit = handler;
      return Promise.resolve(unlisten);
    });
    refreshStatus.mockResolvedValue(undefined);
    refreshCommits.mockResolvedValue(undefined);
    refreshDiff.mockResolvedValue(undefined);
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
    expect(invoke).toHaveBeenCalledWith('unwatch_repo');

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
});
