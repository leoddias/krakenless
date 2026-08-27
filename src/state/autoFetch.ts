/**
 * Background fetch for the open repository.
 *
 * Everything another developer does happens on a machine this one cannot see.
 * The filesystem watcher covers the local repository and nothing else, so
 * without a fetch the branch list is only ever as fresh as the last time
 * somebody clicked Fetch — a branch pushed an hour ago simply does not exist
 * locally yet.
 *
 * Three rules keep this from being felt:
 *
 * - It is *silent*. No busy flag, so no button is disabled and no click is lost
 *   under a background task; no notice on failure, because a closed laptop lid,
 *   a VPN that is not up yet, or an SSH agent that has not been unlocked are
 *   all normal states for a machine to be in, and none of them is news the user
 *   asked for. A fetch the user *asks* for still reports what went wrong.
 * - It is *read-only*. `git fetch` moves remote-tracking refs and nothing else:
 *   no working-tree file, no local branch, no HEAD. Nothing here can lose work.
 * - It *yields*. A tick that lands while the user is mid-operation is skipped
 *   rather than queued, and a tick that lands while the previous fetch is still
 *   running is dropped, so a slow remote can never stack fetches up behind it.
 */

import { fetch as gitFetch } from '../git/refs';
import {
  refreshBranches,
  refreshCommits,
  refreshRemotes,
  refreshStatus,
} from './actions';
import { isBusy, type Store } from './store';

/**
 * Delay before the first fetch after a repository opens.
 *
 * Not zero: opening a repository already runs a handful of git commands, and
 * the panels the user is waiting for should not queue behind a network round
 * trip. Short enough that a repository left open for a minute is current.
 */
export const FIRST_FETCH_DELAY_MS = 3_000;

export interface AutoFetchHandle {
  /** Stops the schedule and waits for a fetch already in flight. */
  stop: () => Promise<void>;
}

/** A schedule that does nothing, for when the setting is off. */
function idleHandle(): AutoFetchHandle {
  return { stop: () => Promise.resolve() };
}

/**
 * Fetches `root` every `minutes`, refreshing the panels a fetch can change.
 *
 * `minutes` of `0` — the "off" setting — starts nothing at all: no timer, and
 * therefore no request, which is the promise the setting makes.
 */
export function startAutoFetch(
  store: Store,
  root: string,
  minutes: number,
): AutoFetchHandle {
  if (minutes <= 0) return idleHandle();

  const period = minutes * 60_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> = Promise.resolve();
  let stopped = false;

  const tick = (): void => {
    running = running.then(() => runFetch(store, root, () => stopped));
    // Chained off the fetch rather than a fixed interval: the gap the user
    // chose is a gap between fetches, not a deadline a slow remote can make the
    // app miss and then try to catch up on.
    void running.then(() => {
      if (!stopped) timer = setTimeout(tick, period);
    });
  };

  timer = setTimeout(tick, Math.min(FIRST_FETCH_DELAY_MS, period));

  return {
    async stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      await running;
    },
  };
}

/**
 * One background fetch, and the refresh of whatever it may have moved.
 *
 * Exported for the tests: the schedule is timers, this is the behaviour.
 */
export async function runFetch(
  store: Store,
  root: string,
  cancelled: () => boolean = () => false,
): Promise<void> {
  const state = store.getState();

  // An operation the user started is already going to refresh everything when
  // it lands, and two git processes writing `.git/` at once is a class of
  // problem worth never having.
  if (isBusy(state)) return;

  // A repository with no remote has nothing to fetch from, and asking anyway
  // costs a process and produces an error nobody would ever see.
  if (state.remotes.state === 'ready' && state.remotes.value.length === 0) return;

  try {
    // `--prune`, so a branch deleted on the remote stops being offered here;
    // that only ever removes a remote-tracking ref, never a local branch.
    await gitFetch(root, { prune: true });
  } catch {
    // Offline, no credentials, remote gone — all ordinary, none of them the
    // user's problem right now. The Fetch button still says so when asked.
    return;
  }

  if (cancelled()) return;

  // Only what a fetch can change: remote-tracking branches, the commits they
  // point at, the ahead/behind on the current branch, and the remote list
  // itself (a pruned or renamed remote shows up here). The working tree and
  // the stash list cannot move, so they are not re-read.
  await Promise.all([
    refreshBranches(store),
    refreshCommits(store),
    refreshStatus(store),
    refreshRemotes(store),
  ]);
}
