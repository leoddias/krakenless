/**
 * "Open this path as a tab", from anywhere inside a tab.
 *
 * A worktree row in the history and an entry in the branch picker both need to
 * open a *different* checkout, and neither has any business knowing about tabs:
 * the tab list lives in `App`, is derived from the home store, and is the one
 * place allowed to decide whether a path needs a new tab or already has one
 * (see `views/shell/tabs.ts`).
 *
 * So this is the same shape as the settings registry next door — a tiny
 * module-level channel, subscribed to by `App` and published to by whoever has
 * a path in hand. One subscriber is expected; several are harmless.
 */

type Listener = (path: string) => void;

const listeners = new Set<Listener>();

/** Subscribes to open requests. Returns the unsubscribe. */
export function subscribeOpenRequests(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Asks the app to show `path`, opening a tab for it if none is open. */
export function requestOpenRepository(path: string): void {
  for (const listener of listeners) listener(path);
}

/** For tests: forget every subscriber. */
export function resetOpenRequests(): void {
  listeners.clear();
}
