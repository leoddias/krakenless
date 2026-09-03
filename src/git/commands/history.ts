/**
 * Builders for the operations offered on a commit in the history panel.
 *
 * Two hazards shape this file. The first is the editor: `revert` and an
 * annotated `tag` both spawn one when no message is supplied, and the runner
 * has no terminal to give it — the command would sit there until the timeout
 * killed it. So a message is either passed or the builder refuses. The second
 * is the usual one (ADR-0016): anything that can move a branch off commits is
 * marked `destructive` here *and* recognized by `isDestructive()` from the
 * arguments, so the flag is documentation and the arg check is the enforcement.
 */

import { assertRefName, assertRevision } from '../argsafety';
import type { GitCommand } from '../types';

/**
 * Creates a tag at `rev`.
 *
 * Never `--force`: an existing tag is a name someone may already have pushed,
 * and moving it silently is the kind of edit that is invisible in a diff. Git's
 * refusal is reported instead.
 */
export function buildTagCommand(
  name: string,
  rev: string,
  options: { message?: string } = {},
): GitCommand {
  const args = ['tag'];
  if (options.message !== undefined) {
    if (options.message.trim().length === 0) {
      throw new Error('An annotated tag needs a message');
    }
    args.push('--annotate', '--message', options.message);
  }
  args.push(assertRefName(name), assertRevision(rev));
  return { args };
}

/**
 * Applies `rev` on top of HEAD as a new commit.
 *
 * Additive: git refuses outright when the working tree would be clobbered, so
 * nothing here can overwrite an edit. A conflict leaves the repository
 * mid-operation, which the conflict banner already reports.
 */
export function buildCherryPickCommand(rev: string): GitCommand {
  return { args: ['cherry-pick', assertRevision(rev)] };
}

/**
 * Records a new commit undoing `rev`.
 *
 * `--no-edit` is load-bearing, not a convenience: without it git opens the
 * user's editor for the generated message, and this process has no terminal to
 * host one.
 */
export function buildRevertCommand(rev: string): GitCommand {
  return { args: ['revert', '--no-edit', assertRevision(rev)] };
}

/**
 * Merges `rev` into the branch that is checked out.
 *
 * `--no-edit` is load-bearing for the same reason it is on revert: a merge that
 * cannot fast-forward writes a commit, and without this git opens the user's
 * editor for its message in a process that has no terminal to host one.
 *
 * Not marked destructive, and that is not an oversight. A merge only ever adds
 * to the branch — the commits that were there stay reachable, `ORIG_HEAD` names
 * where it was, and a merge that stops on a conflict is undone by
 * `git merge --abort`, which *is* gated. Git also refuses outright rather than
 * overwriting a file the user has edited. The confirmation this operation gets
 * is the UI's, not the runner's.
 */
export function buildMergeCommand(rev: string): GitCommand {
  return {
    args: ['merge', '--no-edit', assertRevision(rev)],
    // A merge across a long-diverged branch touches every file it has to
    // rewrite; the default sub-second budget is not for this.
    timeoutMs: 120_000,
  };
}

/**
 * Replays the current branch onto `onto`.
 *
 * Rewrites history — every replayed commit gets a new oid — so it is
 * destructive even though the old commits survive in the reflog.
 *
 * `--autostash` is unconditional. git refuses to rebase over a dirty working
 * tree, and the app used to relay that refusal as a greyed-out menu item that
 * sent the user to a terminal to stash by hand. Git's own answer is better than
 * ours: it stashes before the replay and restores after it, in one command,
 * with the changes recoverable the whole time. On a clean tree the flag creates
 * nothing and costs nothing.
 *
 * What it does *not* do is guarantee the restore succeeds. When re-applying the
 * autostash conflicts, git says so, keeps the entry, and still exits 0 —
 * `rebaseOnto` reads the output for exactly that, because a "rebased" that
 * quietly left conflict markers in the working tree is the worst outcome here.
 */
export function buildRebaseCommand(onto: string): GitCommand {
  return {
    args: ['rebase', '--autostash', assertRevision(onto)],
    destructive: true,
    // A rebase over a long branch is not a sub-second command.
    timeoutMs: 120_000,
  };
}

/**
 * Reads the branch HEAD is on, or nothing at all when HEAD is detached.
 *
 * `--quiet` is what makes the detached case an empty answer with exit code 1
 * instead of an error on stderr, so the caller can tell "not on a branch" from
 * "the command failed".
 */
export function buildCurrentBranchCommand(): GitCommand {
  return { args: ['symbolic-ref', '--quiet', '--short', 'HEAD'] };
}

export type ResetMode = 'soft' | 'mixed' | 'hard';

/**
 * Moves the current branch to `rev`.
 *
 * All three modes are marked destructive, though `isDestructive()` only
 * recognizes `--hard` from the arguments: a soft or mixed reset does not touch
 * the working tree, but it still takes the branch off commits, and the user has
 * to have been asked before any of them runs.
 */
export function buildResetCommand(rev: string, mode: ResetMode): GitCommand {
  return { args: ['reset', `--${mode}`, assertRevision(rev)], destructive: true };
}
