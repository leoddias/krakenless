import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  refreshBranches,
  refreshCommits,
  refreshDiff,
  refreshRemotes,
  refreshStashes,
  refreshStatus,
  refreshWorktrees,
} from './actions';
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
  let token: number | null = null;

  const refresh = (): void => {
    running = running.then(async () => {
      if (stopped) return;
      // Every panel, not just the working tree. A branch created, a commit
      // made or a stash pushed from a terminal changes `.git/refs` without
      // touching a single tracked file, and re-reading only status, commits
      // and diff left the branch and stash lists showing a repository that had
      // already moved on — stale until something else happened to reload them.
      await Promise.all([
        refreshStatus(store),
        refreshCommits(store),
        refreshDiff(store),
        refreshBranches(store),
        refreshRemotes(store),
        refreshStashes(store),
        // Another checkout's uncommitted work is not under this watch at all,
        // but its commits are: the `.git` is shared, so a commit made over
        // there wakes us, and that is the moment its WIP row is wrong.
        refreshWorktrees(store),
      ]);
    });
  };

  // The event is global — one channel for every watch in the process — so each
  // listener has to recognise its own. With several repositories open at once,
  // an unfiltered listener would re-read every panel of every tab each time any
  // one of them changed.
  const unlisten = await listen<number>(REPO_CHANGED_EVENT, (event) => {
    if (stopped) return;
    if (token !== null && event.payload !== token) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(refresh, REFRESH_DELAY_MS);
  });

  // The token identifies *this* watch. Two watches overlap whenever the effect
  // that owns them re-runs (React's StrictMode does exactly that on every mount
  // in development) — and an untokenized stop would tear down whichever watch
  // happened to be current, which is usually the newer one. The app would then
  // be watching nothing, and every change made outside it would go unnoticed
  // until the user clicked something.
  // Assigned after the listener is attached, so an event that arrives during
  // the round trip is not dropped for belonging to "no token yet".
  token = await invoke<number>('watch_repo', { path: root });

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
