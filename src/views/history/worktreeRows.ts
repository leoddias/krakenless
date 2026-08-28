/**
 * Putting the other worktrees onto the timeline.
 *
 * A linked worktree is a second checkout of this repository with its own
 * uncommitted work, and until you see it on the graph the only evidence it
 * exists is that a branch you expected to be free is "already checked out".
 * GitKraken draws it as a WIP node hanging off the commit that worktree has
 * checked out, and that is the right picture: the work is *ahead* of that
 * commit and belongs to nobody else.
 *
 * There is no commit to draw it with, so one is synthesised — a row whose only
 * parent is the worktree's HEAD, which is all the graph layout needs to draw
 * the stub connecting the two. Its oid is deliberately not a sha (`worktree:`
 * followed by the path) so that nothing downstream can mistake it for something
 * git could be asked about.
 *
 * Pure, and separate from the view, for the same reason `stashRows` is: "which
 * rows appear that git did not report" is a rule that has to be readable.
 */

import type { WorktreeSummary } from '../../git/worktrees';
import type { Commit } from '../../git/types';
import type { Loadable } from '../../state/store';

/** Prefix that marks a synthetic row. No sha can collide with it. */
export const WORKTREE_ROW_PREFIX = 'worktree:';

export interface WorktreeHistory {
  /** Commits to draw, with a WIP row inserted above each worktree's HEAD. */
  commits: Commit[];
  /** The worktree a synthetic row stands for, by that row's oid. */
  worktreeRows: Map<string, WorktreeSummary>;
}

/** The row id for a worktree. Stable, because the path is. */
export function worktreeRowOid(worktree: WorktreeSummary): string {
  return `${WORKTREE_ROW_PREFIX}${worktree.path}`;
}

/** True for a row this module invented. */
export function isWorktreeRow(oid: string): boolean {
  return oid.startsWith(WORKTREE_ROW_PREFIX);
}

/**
 * Inserts a WIP row above the commit each worktree has checked out.
 *
 * A worktree is skipped when there is nothing to draw or nowhere to draw it:
 *
 * - the main worktree, which is the window you are already looking at;
 * - a bare or prunable one, which has no files to have work in;
 * - one whose HEAD is not in the loaded page — the row has to hang off its
 *   commit, and a stub pointing at a commit that is not on screen would draw a
 *   line into nothing. It comes back as soon as that commit is loaded.
 *
 * A worktree with a clean tree still gets a row: "somebody has this branch
 * open, with nothing uncommitted" is exactly as useful to know.
 */
export function applyWorktrees(
  commits: Commit[],
  worktrees: Loadable<WorktreeSummary[]>,
): WorktreeHistory {
  if (worktrees.state !== 'ready' || worktrees.value.length === 0) {
    return { commits, worktreeRows: new Map() };
  }

  const drawable = worktrees.value.filter(
    (worktree) =>
      !worktree.main &&
      !worktree.bare &&
      worktree.prunable === null &&
      worktree.head !== null,
  );
  if (drawable.length === 0) return { commits, worktreeRows: new Map() };

  const byHead = new Map<string, WorktreeSummary[]>();
  for (const worktree of drawable) {
    const head = worktree.head;
    if (head === null) continue;
    byHead.set(head, [...(byHead.get(head) ?? []), worktree]);
  }

  const rows: Commit[] = [];
  const worktreeRows = new Map<string, WorktreeSummary>();
  for (const commit of commits) {
    for (const worktree of byHead.get(commit.oid) ?? []) {
      const row = synthesise(worktree, commit);
      worktreeRows.set(row.oid, worktree);
      rows.push(row);
    }
    rows.push(commit);
  }

  return { commits: rows, worktreeRows };
}

/**
 * The stand-in commit for a worktree's uncommitted state.
 *
 * Dated from the commit it hangs off rather than from `now`: the row is not an
 * event that happened at this instant, and a "moments ago" timestamp on it
 * would be a fact the app invented.
 */
function synthesise(worktree: WorktreeSummary, head: Commit): Commit {
  return {
    oid: worktreeRowOid(worktree),
    shortOid: '',
    parents: [head.oid],
    authorName: '',
    authorEmail: '',
    authorDate: head.authorDate,
    committerName: '',
    committerDate: head.committerDate,
    subject: '',
    body: '',
    refs: [],
  };
}

/** The last path segment, which is what a worktree is called in practice. */
export function worktreeName(worktree: WorktreeSummary): string {
  const parts = worktree.path.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] ?? worktree.path;
}

/** "3 changed, 2 new", or null when the status could not be read. */
export function worktreeChangeSummary(worktree: WorktreeSummary): string | null {
  if (worktree.changed === null || worktree.untracked === null) return null;
  if (worktree.changed === 0 && worktree.untracked === 0) return 'no uncommitted changes';
  const parts: string[] = [];
  if (worktree.changed > 0) parts.push(`${String(worktree.changed)} changed`);
  if (worktree.untracked > 0) parts.push(`${String(worktree.untracked)} new`);
  return parts.join(', ');
}
