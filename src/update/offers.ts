/**
 * "Ask about this update now", from the Settings screen.
 *
 * The dialog lives in `App`, above the tabs, because replacing the application
 * is not a repository's business. Settings lives inside a tab. So the manual
 * *Check for updates* button has an update in hand and nowhere to show it, and
 * without this it could only promise that the hourly schedule would get round
 * to it — a promise that is true and useless, since "within the hour" is not an
 * answer to a button someone just pressed.
 *
 * Same shape as `state/openRequests.ts`: a module-level channel with one
 * expected subscriber.
 */

import type { AvailableUpdate } from './check';

type Listener = (update: AvailableUpdate) => void;

const listeners = new Set<Listener>();

/** Subscribes to manually-found updates. Returns the unsubscribe. */
export function subscribeUpdateOffers(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Asks the app to put `update` in front of the user now. */
export function offerUpdate(update: AvailableUpdate): void {
  for (const listener of listeners) listener(update);
}

/** For tests: forget every subscriber. */
export function resetUpdateOffers(): void {
  listeners.clear();
}
