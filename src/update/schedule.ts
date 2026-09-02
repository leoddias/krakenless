/**
 * When the app asks whether there is a newer Krakenless.
 *
 * Originally this ran once per launch, which is fine for a machine that is
 * rebooted daily and useless for the one this app is actually used on: a
 * desktop that stays open for days at a time and would never learn about a
 * release until something else made the user restart it.
 *
 * So it repeats, on the same shape of schedule as the background fetch
 * (`state/autoFetch.ts`): a chained timeout rather than an interval, so a slow
 * or hanging check cannot stack a queue of them behind it, and the gap is a gap
 * *between* checks rather than a deadline the app can fall behind on.
 *
 * The cost of a tick is one conditional GET of a small static file, and a tick
 * that finds nothing does nothing at all.
 */

import { checkForUpdate, type AvailableUpdate } from './check';

/**
 * Gap between checks, in milliseconds.
 *
 * An hour is short enough that a user who leaves the app open all week is
 * offered a release the day it lands, and long enough that the request is
 * invisible next to the git traffic the app already makes.
 */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Delay before the first check.
 *
 * Not zero, for the same reason the first background fetch is not: startup is
 * already opening repositories and running git, and the window should be
 * usable before anything reaches for the network.
 */
export const FIRST_UPDATE_CHECK_DELAY_MS = 10_000;

export interface UpdateScheduleHandle {
  /** Stops the schedule. A check already in flight is ignored, not awaited. */
  stop: () => void;
}

/**
 * Checks for updates on a repeating schedule, reporting each one found.
 *
 * `onFound` is called with every check that finds something — including the
 * same version again on the next tick. Deciding whether that is worth showing
 * belongs to the caller, which is the only place that knows what the user has
 * already been asked about and answered.
 */
export function startUpdateChecks(
  onFound: (update: AvailableUpdate) => void,
  options: { intervalMs?: number; firstDelayMs?: number } = {},
): UpdateScheduleHandle {
  const interval = options.intervalMs ?? UPDATE_CHECK_INTERVAL_MS;
  const firstDelay = options.firstDelayMs ?? FIRST_UPDATE_CHECK_DELAY_MS;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const tick = (): void => {
    void checkForUpdate()
      .then((update) => {
        // The check outliving the schedule is normal — the window can close
        // mid-request — and reporting an update to a caller that has gone away
        // is how a dialog reappears after being dismissed.
        if (stopped) return;
        if (update !== null) onFound(update);
      })
      .catch(() => {
        // `checkForUpdate` already swallows its own failures; this only keeps a
        // surprise from cancelling every future tick.
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, interval);
      });
  };

  timer = setTimeout(tick, Math.min(firstDelay, interval));

  return {
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
