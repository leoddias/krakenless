/**
 * Recognising stashes inside the commit list.
 *
 * `git log --all` walks `refs/stash` too, so a stash arrives in the history as
 * what it actually is: a merge commit whose first parent is where you were, and
 * whose other parents are two synthetic commits holding the index and the
 * untracked files. Drawn literally that is three rows — "On main: WIP on main",
 * "index on main: ee84891 …", and a nameless third — none of which says
 * "stash", and two of which are git's bookkeeping rather than anything the user
 * saved.
 *
 * So this collapses them to one row. The extra parents are dropped from the
 * list *and* from the stash commit's own parent list, because the graph draws
 * an edge per parent and a hidden parent would leave a line running to a commit
 * that is not on screen.
 *
 * Pure, and separate from the view, because "which rows disappear" is the kind
 * of rule that is easy to get subtly wrong and impossible to see afterwards.
 */

import type { Commit, StashEntry } from '../../git/types';
import type { Loadable } from '../../state/store';

export interface StashedHistory {
  /** Commits to draw: stash bookkeeping removed. */
  commits: Commit[];
  /** The stash entry for a commit's oid, when that commit is a stash. */
  stashes: Map<string, StashEntry>;
}

/**
 * Collapses every stash in `commits` to a single row.
 *
 * The stash list is the authority on what is a stash — a commit is one because
 * a `stash@{n}` points at it, never because its message looks like git's. Until
 * that list has been read the history is returned untouched: guessing from the
 * subject would hide real commits from anyone who writes "index on main:" in a
 * message.
 */
export function applyStashes(
  commits: Commit[],
  stashes: Loadable<StashEntry[]>,
): StashedHistory {
  if (stashes.state !== 'ready' || stashes.value.length === 0) {
    return { commits, stashes: new Map() };
  }

  const byOid = new Map(stashes.value.map((entry) => [entry.oid, entry]));
  const internal = new Set<string>();
  for (const commit of commits) {
    if (!byOid.has(commit.oid)) continue;
    // Everything past the first parent is the index/untracked snapshot. The
    // first parent is where the user was standing, which is real history.
    for (const parent of commit.parents.slice(1)) {
      // A stash of a stash is not a thing, but if two entries ever pointed at
      // one commit, hiding the row the user can act on would be the worse bug.
      if (!byOid.has(parent)) internal.add(parent);
    }
  }

  const visible: Commit[] = [];
  for (const commit of commits) {
    if (internal.has(commit.oid)) continue;
    visible.push(
      byOid.has(commit.oid) && commit.parents.length > 1
        ? { ...commit, parents: commit.parents.slice(0, 1) }
        : commit,
    );
  }
  return { commits: visible, stashes: byOid };
}

/**
 * What a stash row says.
 *
 * Git writes two shapes of reflog subject and they want opposite treatment.
 * `On <branch>: <message>` is a stash the user named, and the name is the
 * only interesting half. `WIP on <branch>: <sha> <subject>` is an unnamed one,
 * where the trailing sha and subject describe the commit it was taken on, not
 * the saved work — so the row keeps `WIP on <branch>` and drops the rest.
 */
export function stashRowLabel(entry: StashEntry): string {
  const named = /^On [^:]+: (.+)$/s.exec(entry.message);
  if (named !== null) return (named[1] ?? '').trim();

  const wip = /^(WIP on [^:]+):/.exec(entry.message);
  if (wip !== null) return wip[1] ?? entry.ref;

  return entry.message.trim().length > 0 ? entry.message.trim() : entry.ref;
}
