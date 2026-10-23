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

import { samePath } from '../git/worktrees';

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

/**
 * The roots open as tabs right now, published by `App` whenever the list
 * changes.
 *
 * The question it answers runs the other way from the channel above — not
 * "open this", but "is this open?" — and is asked before a worktree's folder is
 * deleted. A tab watches its folder for as long as it is open (hidden tabs
 * included), and on Windows a watched directory cannot be removed: git would
 * delete the files and then fail on the folder, leaving half a checkout behind.
 */
let openRoots: readonly string[] = [];

/** Replaces the list of open roots. Only `App` calls this. */
export function publishOpenRoots(roots: readonly string[]): void {
  openRoots = roots;
}

/**
 * Whether `path`, or a folder inside it, is open in a tab — compared the way
 * the tab list compares.
 *
 * Inside counts: a repository cloned into a worktree's folder is deleted with
 * it, and a tab watching that one holds the folder just the same.
 */
export function isOpenInTab(path: string): boolean {
  const normalise = (value: string): string =>
    value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const folder = normalise(path);
  return openRoots.some((root) => {
    if (samePath(root, path)) return true;
    return normalise(root).startsWith(`${folder}/`);
  });
}

/** For tests: forget every subscriber and every open root. */
export function resetOpenRequests(): void {
  listeners.clear();
  openRoots = [];
}
