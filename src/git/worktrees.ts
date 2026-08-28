/**
 * Reading the repository's worktrees, and how much is uncommitted in each.
 *
 * A linked worktree is a checkout the app can see but is not standing in: its
 * files, its index and its HEAD are its own, and nothing the filesystem watcher
 * hears about this repository says a word about them. So the count of what is
 * uncommitted over there has to be asked for, one `git status` per worktree,
 * run *in* that worktree — which is all it takes, because `git` resolves the
 * shared `.git` from wherever it is invoked.
 *
 * Nothing here writes. Adding and removing worktrees is deliberately not built
 * (ADR-0027): `git worktree add` creates a directory outside the repository and
 * `remove` deletes one off disk, and neither belongs in a first pass.
 */

import { buildWorktreeListCommand } from './commands/worktree';
import { parseWorktrees } from './parsers/worktree';
import { runGit } from './runner';
import { getStatus } from './status';
import type { RepoStatus, Worktree } from './types';

/** A worktree plus what is uncommitted in it, when that could be read. */
export interface WorktreeSummary extends Worktree {
  /**
   * Tracked files changed in the index or on disk, and files git does not know
   * about yet. `null` for both when the status could not be read — a worktree
   * whose directory is gone is the ordinary case, and a zero there would be a
   * confident lie about a checkout nobody can see.
   */
  changed: number | null;
  untracked: number | null;
}

/** Lists the worktrees, main one first. */
export async function listWorktrees(repo: string): Promise<Worktree[]> {
  const output = await runGit(repo, buildWorktreeListCommand());
  return parseWorktrees(output.stdout);
}

/** How many files are changed and how many are untracked, from one status. */
export function countChanges(status: RepoStatus): {
  changed: number;
  untracked: number;
} {
  let changed = 0;
  let untracked = 0;
  for (const entry of status.entries) {
    if (entry.index === 'untracked' || entry.worktree === 'untracked') {
      untracked += 1;
      continue;
    }
    if (entry.index === 'ignored' || entry.worktree === 'ignored') continue;
    changed += 1;
  }
  return { changed, untracked };
}

/**
 * Lists the worktrees and counts what is uncommitted in each.
 *
 * The statuses are read in parallel and every failure is absorbed into a `null`
 * count: a locked worktree on a disconnected drive, a directory somebody
 * deleted by hand, a path that needs a permission this process does not have —
 * none of those is a reason to leave the *list* unread, which is the part the
 * user came for.
 *
 * `skip` is the worktree the app is already standing in: its uncommitted work
 * is what the whole rest of the window is about, and re-reading it here would
 * be a second answer to a question already on screen.
 */
export async function listWorktreeSummaries(
  repo: string,
  options: { skip?: string } = {},
): Promise<WorktreeSummary[]> {
  const worktrees = await listWorktrees(repo);

  return Promise.all(
    worktrees.map(async (worktree) => {
      const blank = { ...worktree, changed: null, untracked: null };
      if (worktree.bare) return blank;
      if (worktree.prunable !== null) return blank;
      if (options.skip !== undefined && samePath(worktree.path, options.skip)) {
        return blank;
      }
      try {
        return { ...worktree, ...countChanges(await getStatus(worktree.path)) };
      } catch {
        return blank;
      }
    }),
  );
}

/**
 * Whether two paths name the same directory.
 *
 * Separators and case only: git prints forward slashes on Windows while the
 * rest of the app carries whatever the picker returned, and `C:/Repos/App` and
 * `c:/repos/app` are one directory there. This is the same comparison the tab
 * list makes (ADR-0023), and deliberately wrong in the same safe direction on a
 * case-sensitive filesystem — one match too many, never one too few.
 */
export function samePath(left: string, right: string): boolean {
  const normalise = (path: string): string =>
    path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return normalise(left) === normalise(right);
}
