/**
 * Builders for the repository's worktrees.
 *
 * Listing, removing one (ADR-0065), and detaching one so another checkout can
 * take its branch (ADR-0068). `git worktree add` is still not built:
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

/**
 * Detaches HEAD where it stands — run *inside* the worktree that holds a
 * branch, to let go of it.
 *
 * No start point, on purpose: `git switch --detach` with nothing after it
 * detaches at the commit already checked out, so not one file, the index or
 * an uncommitted change moves, and it works over a dirty tree. The branch
 * keeps pointing where it did; the worktree is simply no longer *on* it, which
 * is what lets another checkout take it (ADR-0068).
 */
export function buildDetachHeadCommand(): GitCommand {
  return { args: ['switch', '--detach'] };
}

/**
 * Reads the full ref HEAD is on, run in a worktree just before it is detached.
 *
 * The full `refs/heads/<name>` rather than `--short`: the short form of a
 * branch is ambiguous with a tag of the same name, and this answer decides
 * whether somebody's checkout is changed. `--quiet` makes a detached HEAD an
 * empty answer with exit code 1 rather than an error.
 */
export function buildHeadRefCommand(): GitCommand {
  return { args: ['symbolic-ref', '--quiet', 'HEAD'] };
}

/**
 * Asks whether a bisect is under way in the worktree it runs in.
 *
 * Read-only: `bisect log` prints the session's log and exits 0 while one is
 * going, and exits 1 ("We are not bisecting.") otherwise. Asked because a
 * `bisect start --no-checkout` keeps the branch checked out, and detaching it
 * would make the eventual `bisect reset` there fail.
 */
export function buildBisectLogCommand(): GitCommand {
  return { args: ['bisect', 'log'] };
}
