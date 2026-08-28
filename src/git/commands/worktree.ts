/**
 * Builders for reading the repository's worktrees.
 *
 * Read-only, and deliberately so: `git worktree add` writes a directory outside
 * the repository and `git worktree remove` deletes one off disk, and neither is
 * something this app does yet (ADR-0027). What is here lists what already
 * exists, so the app can show it and open it.
 */

import type { GitCommand } from '../types';

/**
 * Lists every worktree attached to this repository, the main one first.
 *
 * `--porcelain` is not a nicety here. The human format writes the path, the
 * short sha and the branch on one space-separated line, which is unparseable
 * the moment a path contains a space — and a worktree under
 * `C:/Users/Ada Lovelace/` is an ordinary thing to have. The porcelain form
 * puts one fact per line and terminates each record with a blank line.
 */
export function buildWorktreeListCommand(): GitCommand {
  return { args: ['worktree', 'list', '--porcelain'] };
}
