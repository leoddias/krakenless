/**
 * Builders for the operation a repository is stopped in the middle of.
 *
 * The rule this file exists to enforce: **a merge, a rebase, a cherry-pick and
 * a revert are four different states with four different ways out, and the app
 * must know which one it is in before it offers anything.** Offering
 * `git merge --abort` during a rebase is not a cosmetic error — it fails with
 * "There is no merge to abort (MERGE_HEAD missing)" and leaves the user stopped
 * mid-rebase on a detached HEAD with no way forward from the UI at all.
 *
 * Detection is done with `rev-parse --verify` against the pseudo-refs git
 * writes for exactly this purpose, rather than by looking at files: they are
 * refs, git resolves them, and the answer works the same in a linked worktree
 * where `.git` is a file rather than a directory.
 */

import type { GitCommand } from '../types';

/**
 * Pseudo-refs that exist only while an operation is stopped.
 *
 * `REBASE_HEAD` is the commit being replayed; git writes it whenever a rebase
 * stops, for a conflict or for an `edit`. The other three name the commit whose
 * application is unfinished.
 */
export const OPERATION_REFS = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'REBASE_HEAD',
] as const;

export type OperationRef = (typeof OPERATION_REFS)[number];

/**
 * Asks whether one pseudo-ref exists.
 *
 * `--verify --quiet` is what makes "it does not exist" an exit code rather than
 * noise on stderr, so the caller can tell absence from failure.
 */
export function buildRefExistsCommand(ref: OperationRef): GitCommand {
  return { args: ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`] };
}

/**
 * Continues the operation after its conflicts have been staged.
 *
 * `-c core.editor=true` is load-bearing, not a preference. Continuing a rebase,
 * a cherry-pick or a revert opens an editor for the commit message, and this
 * process has no terminal to host one — the command would sit there until the
 * timeout killed it, mid-rebase. The runner scrubs `GIT_EDITOR` from the
 * environment, but `core.editor` comes from the user's config and would still
 * be honoured; `true` is the program that exits 0 without doing anything, which
 * git reads as "the message was accepted unchanged".
 */
export function buildContinueCommand(kind: ContinuableKind): GitCommand {
  return {
    args: ['-c', 'core.editor=true', kind, '--continue'],
    destructive: true,
    timeoutMs: CONTINUE_TIMEOUT_MS,
  };
}

/**
 * Skips the commit the operation is stopped on and moves to the next one.
 *
 * Destructive in the sense the safety gate means: the commit being replayed is
 * dropped from the result. It stays in the reflog, and it is still on the
 * branch being rebased *from* — but the user has to have asked.
 */
export function buildSkipCommand(kind: ContinuableKind): GitCommand {
  return { args: [kind, '--skip'], destructive: true, timeoutMs: CONTINUE_TIMEOUT_MS };
}

/** Abandons the operation and puts the repository back where it started. */
export function buildAbortCommand(kind: OperationKind): GitCommand {
  return { args: [kind, '--abort'], destructive: true, timeoutMs: CONTINUE_TIMEOUT_MS };
}

/**
 * A rebase replays every remaining commit when it continues, so it is not a
 * sub-second command the way the local operations are.
 */
const CONTINUE_TIMEOUT_MS = 120_000;

/** Operations that stop, wait for the user, and can be resumed. */
export type ContinuableKind = 'rebase' | 'cherry-pick' | 'revert';

/** Every operation this app knows how to recognise and end. */
export type OperationKind = ContinuableKind | 'merge';

/**
 * Whether an operation can be continued at all.
 *
 * A merge cannot: there is no `git merge --continue` that means "resume" — the
 * way out of a stopped merge is to commit the resolution, which is what the
 * commit box is for.
 */
export function isContinuable(kind: OperationKind): kind is ContinuableKind {
  return kind !== 'merge';
}
