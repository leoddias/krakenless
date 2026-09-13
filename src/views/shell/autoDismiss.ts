/**
 * The timer that takes a dismissible notice off the screen.
 *
 * Every "Dismiss" in the app shares it, so a notice behaves the same wherever
 * it appears rather than each panel inventing its own lifetime.
 *
 * The delay is fixed and does not pause — not on hover, not while the window is
 * in the background. That is a deliberate simplification: a timer that stops
 * and starts is a timer nobody can predict, and the button is still there for
 * anyone who wants the notice gone sooner.
 *
 * **This overrides an older rule, and the override has a cost.** Notices used
 * to stay until dismissed because a discard's backup oid and its Undo button
 * are the only route back to discarded work (ADR-0045), and a notice that
 * vanishes takes that route with it. The blob itself survives in the object
 * store — a dismissal has never been what loses the work — but its name leaves
 * the screen after ten seconds, and `git fsck --lost-found` is what finds it
 * afterwards. See ADR-0051.
 */

import { useEffect, useRef } from 'react';

/** How long a dismissible notice stays on screen. */
export const DISMISS_AFTER_MS = 10_000;

/**
 * Calls `dismiss` once, `DISMISS_AFTER_MS` after `key` last changed.
 *
 * `key` is the identity of the thing on screen: a notice id, a blob oid, the
 * message text. A new key restarts the clock, `null` means nothing is showing
 * and no timer runs. Re-showing a notice whose key is *equal* to the one
 * already displayed does not restart it — the notice never left the screen, so
 * the ten seconds the user has already had are the ten seconds that count.
 *
 * `dismiss` is read through a ref, so a caller may pass a fresh closure on
 * every render without resetting the timer.
 */
export function useAutoDismiss(key: string | number | null, dismiss: () => void): void {
  const latest = useRef(dismiss);
  // Written in an effect rather than during render: the timer only ever reads
  // it from a callback, so the value it needs is the one from the last
  // committed render, and assigning during render is a lint error besides.
  useEffect(() => {
    latest.current = dismiss;
  });

  useEffect(() => {
    if (key === null) return;
    const timer = setTimeout(() => {
      latest.current();
    }, DISMISS_AFTER_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [key]);
}
