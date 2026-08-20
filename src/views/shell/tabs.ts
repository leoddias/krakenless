/**
 * The open repositories, and which one is on screen.
 *
 * Kept as pure functions over an immutable list so the awkward parts — the same
 * repository asked for twice, closing the tab you are looking at, closing the
 * last one — are decided in one place and tested without rendering anything.
 * Each tab owns its own store; this module never looks inside one.
 */

export interface RepoTab<S> {
  /** Stable across renders, and never reused after a tab closes. */
  id: string;
  /** Absolute worktree root, as git reported it. */
  root: string;
  store: S;
}

export interface Workspace<S> {
  tabs: RepoTab<S>[];
  /** `null` means the home screen: the repository list, no repository open. */
  activeId: string | null;
}

export const HOME: null = null;

/**
 * Compares two worktree roots.
 *
 * Separators are normalised and case is ignored: `C:/repos/App` and
 * `C:\repos\app` are one repository on Windows and macOS, and opening the
 * "second" one would give it its own tab, its own watcher and its own idea of
 * what is staged — two tabs writing to one index. Linux is case-sensitive and
 * this is deliberately wrong there; being wrong in the direction of *one* tab
 * for one path is the safe way round.
 */
export function sameRepo(left: string, right: string): boolean {
  return normalizeRoot(left) === normalizeRoot(right);
}

function normalizeRoot(root: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** The tab showing `root`, or `undefined`. */
export function tabFor<S>(tabs: RepoTab<S>[], root: string): RepoTab<S> | undefined {
  return tabs.find((tab) => sameRepo(tab.root, root));
}

/**
 * Shows `root`, opening a tab for it only if one is not already open.
 *
 * `makeTab` is called only when a new tab is actually needed, so the caller
 * never builds a store it then has to throw away.
 */
export function openRepoTab<S>(
  workspace: Workspace<S>,
  root: string,
  makeTab: () => RepoTab<S>,
): Workspace<S> {
  const existing = tabFor(workspace.tabs, root);
  if (existing !== undefined) {
    return { tabs: workspace.tabs, activeId: existing.id };
  }
  const tab = makeTab();
  return { tabs: [...workspace.tabs, tab], activeId: tab.id };
}

/**
 * Closes a tab and decides what to look at next.
 *
 * Closing a tab you are not looking at leaves you where you are. Closing the
 * one you *are* looking at moves to its right-hand neighbour, falling back to
 * the left — the same rule every browser uses, and the one that keeps the next
 * tab under the pointer that just clicked. Closing the last tab goes home.
 */
export function closeRepoTab<S>(workspace: Workspace<S>, id: string): Workspace<S> {
  const index = workspace.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return workspace;

  const tabs = workspace.tabs.filter((tab) => tab.id !== id);
  if (workspace.activeId !== id) return { tabs, activeId: workspace.activeId };

  const next = tabs[index] ?? tabs[index - 1];
  return { tabs, activeId: next?.id ?? HOME };
}

/** The tab currently on screen, or `undefined` when that is the home screen. */
export function activeTab<S>(workspace: Workspace<S>): RepoTab<S> | undefined {
  if (workspace.activeId === null) return undefined;
  return workspace.tabs.find((tab) => tab.id === workspace.activeId);
}
