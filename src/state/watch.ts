import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { refreshCommits, refreshDiff, refreshStatus } from './actions';
import type { Store } from './store';

/** Event the Rust watcher emits after coalescing a burst of filesystem events. */
export const REPO_CHANGED_EVENT = 'repo-changed';

/**
 * Extra debounce on top of the Rust side's. The watcher already coalesces
 * bursts, but a long operation (a rebase, a big checkout) produces several
 * bursts in a row, and re-reading the whole repository per burst would keep git
 * busy while the repository is still moving.
 */
export const REFRESH_DELAY_MS = 200;

export interface WatchHandle {
  stop: () => Promise<void>;
}

/**
 * Watches the open repository and refreshes the panels when it changes.
 * Refreshes are serialized: a refresh that is still running never overlaps the
 * next one, so the UI cannot end up showing a mix of two repository states.
 */
export async function watchRepository(store: Store, root: string): Promise<WatchHandle> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> = Promise.resolve();
  let stopped = false;

  const refresh = (): void => {
    running = running.then(async () => {
      if (stopped) return;
      await Promise.all([
        refreshStatus(store),
        refreshCommits(store),
        refreshDiff(store),
      ]);
    });
  };

  const unlisten = await listen(REPO_CHANGED_EVENT, () => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(refresh, REFRESH_DELAY_MS);
  });

  // The token identifies *this* watch. Two watches overlap whenever the effect
  // that owns them re-runs (React's StrictMode does exactly that on every mount
  // in development) — and an untokenized stop would tear down whichever watch
  // happened to be current, which is usually the newer one. The app would then
  // be watching nothing, and every change made outside it would go unnoticed
  // until the user clicked something.
  const token = await invoke<number>('watch_repo', { path: root });

  return {
    async stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      unlisten();
      await invoke('unwatch_repo', { token }).catch(() => {
        // Nothing to unwatch is not a failure worth surfacing.
      });
      await running;
    },
  };
}
