/**
 * Builders for the repository's worktrees.
 *
 * Listing, and removing one (ADR-0065). `git worktree add` is still not built:
 * it writes a directory outside the repository, which is the boundary ADR-0022
 * guards, and nobody has asked for it yet.
 */

import { assertAbsolutePath } from '../argsafety';
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

/**
 * Removes a linked worktree: its folder comes off disk and git forgets it.
 *
 * Without `force` git refuses a worktree with anything uncommitted in it —
 * modified *or* untracked, but not ignored: those go without a check — and a
 * locked one, and that refusal is the safe form
 * this app tries first. `force` is a single `--force`, which gets past the
 * uncommitted work and deliberately not past a lock: git wants it twice for
 * that, and a lock is somebody saying "not this one", which no dialog here
 * overrides.
 *
 * The path is the one `git worktree list` printed, absolute, after `--` so a
 * folder whose name starts with a dash is still a folder. The branch the
 * worktree had checked out is untouched; deleting it is its own question.
 */
export function buildWorktreeRemoveCommand(
  path: string,
  options: { force: boolean },
): GitCommand {
  return {
    args: [
      'worktree',
      'remove',
      ...(options.force ? ['--force'] : []),
      '--',
      assertAbsolutePath(path),
    ],
    destructive: true,
  };
}
