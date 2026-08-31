import { assertRevision, pathspec } from '../argsafety';
import { GitError } from '../errors';
import type { GitCommand } from '../types';

/**
 * Builders for staging, unstaging, committing and discarding.
 *
 * Anything that can lose work is marked `destructive` *and* recognized by
 * `isDestructive()` from the argument array (ADR-0016) — the flag here is
 * documentation, the arg check is the enforcement.
 */

/** Stages whole paths. Adding is always recoverable, so it needs no confirmation. */
export function buildStageCommand(paths: string[]): GitCommand {
  return { args: ['add', ...pathspec(paths)] };
}

/**
 * Unstages whole paths. Uses `restore --staged`, which only rewrites the index
 * — the working tree keeps the user's edits either way.
 */
export function buildUnstageCommand(paths: string[]): GitCommand {
  return { args: ['restore', '--staged', ...pathspec(paths)], destructive: true };
}

/**
 * Stages a patch through the index only. `--cached` is what keeps the working
 * tree untouched: a malformed patch can then fail without having changed a
 * single file the user is editing.
 */
export interface ApplyOptions {
  reverse: boolean;
  /**
   * Only for hunks with no context lines. `--unidiff-zero` disables git's
   * context safety check, so passing it unconditionally would throw away the
   * protection that catches a patch aimed at the wrong place in the file.
   */
  zeroContext?: boolean;
}

function applyArgs(options: ApplyOptions, check: boolean): string[] {
  const args = ['apply', '--cached'];
  if (check) args.push('--check');
  args.push('--whitespace=nowarn');
  if (options.zeroContext === true) args.push('--unidiff-zero');
  if (options.reverse) args.push('--reverse');
  // The patch itself arrives on stdin; `-` tells git to read it from there.
  args.push('-');
  return args;
}

export function buildApplyCachedCommand(options: ApplyOptions): GitCommand {
  return { args: applyArgs(options, false), destructive: options.reverse };
}

/** Dry run of the same patch. Used to refuse a patch before it can half-apply. */
export function buildApplyCheckCommand(options: ApplyOptions): GitCommand {
  return { args: applyArgs(options, true) };
}

/**
 * Reverse-applies a patch to the **working tree**, which is how a single hunk
 * is discarded.
 *
 * No `--cached`: the point is to undo the edit on disk. That makes this the one
 * builder here that destroys content git has never seen, so `stage.ts` writes
 * the file to the object store first and hands back the command that restores
 * it. `isDestructive()` recognises the shape independently (ADR-0016).
 */
function worktreeReverseArgs(
  options: { zeroContext?: boolean },
  check: boolean,
): string[] {
  const args = ['apply'];
  if (check) args.push('--check');
  args.push('--whitespace=nowarn');
  if (options.zeroContext === true) args.push('--unidiff-zero');
  args.push('--reverse', '-');
  return args;
}

export function buildDiscardHunkCommand(options: { zeroContext?: boolean }): GitCommand {
  return { args: worktreeReverseArgs(options, false), destructive: true };
}

/** Dry run of the same reverse patch, so a stale selection changes nothing. */
export function buildDiscardHunkCheckCommand(options: {
  zeroContext?: boolean;
}): GitCommand {
  return { args: worktreeReverseArgs(options, true) };
}

/**
 * Writes the file's current bytes into the object store and prints the oid.
 *
 * `--no-filters` is what makes this a backup rather than an approximation: with
 * filters on, a `clean` driver or `core.autocrlf` stores normalised content, so
 * restoring it would rewrite lines the discard never touched.
 */
export function buildBackupBlobCommand(path: string): GitCommand {
  return { args: ['hash-object', '-w', '--no-filters', ...pathspec([path])] };
}

/**
 * Reads a blob back out of the object store by oid.
 *
 * `--textconv` and friends are not in play for `cat-file -p` on a blob, so this
 * returns the stored bytes. The oid is checked against the two real oid
 * lengths rather than passed through `assertRevision`: only an oid this app
 * wrote a moment ago belongs here, and a ref name would be a bug, not a use.
 */
export function buildReadBlobCommand(blobOid: string): GitCommand {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(blobOid)) {
    throw new GitError('bad-argument', `Not an object id: ${blobOid}`);
  }
  return { args: ['cat-file', 'blob', blobOid] };
}

export interface CommitOptions {
  message: string;
  amend?: boolean;
  /** Allows a commit with nothing staged; only used for an explicit empty commit. */
  allowEmpty?: boolean;
}

/**
 * Commits the index. The message travels as its own argument after `-m`, never
 * interpolated into a string, so no message content can become an option.
 */
export function buildCommitCommand(options: CommitOptions): GitCommand {
  if (options.message.trim().length === 0) {
    throw new Error('A commit message is required');
  }
  const args = ['commit', '--message', options.message];
  if (options.amend === true) args.push('--amend');
  if (options.allowEmpty === true) args.push('--allow-empty');
  // Amending rewrites the last commit — recoverable through the reflog, but
  // never something to do without the user asking.
  return { args, destructive: options.amend === true };
}

/**
 * Discards working-tree changes for specific paths *by stashing them*.
 *
 * A path-limited `stash push` reverts exactly those paths and keeps the changes
 * recoverable — verified against git 2.39: other files' edits and untracked
 * files outside the pathspec are left alone. `git restore` would do the same
 * job with no way back, which fails the safety bar.
 *
 * `--keep-index` is load-bearing. Without it the stash reverts the *staged*
 * content to HEAD too, and no `stash pop` puts that snapshot back — discarding
 * an unstaged edit would silently destroy a staged one. With it, discard means
 * "drop my unstaged edits", which is exactly `git restore <path>` semantics.
 */
export function buildDiscardCommand(
  paths: string[],
  label: string,
  options: { keepIndex: boolean },
): GitCommand {
  return {
    args: [
      'stash',
      'push',
      // Only for tracked paths: git 2.39 restores the index side with
      // `checkout-index`, which fails outright on an untracked path
      // ("did not match any file(s) known to git"). An untracked file has no
      // index entry to protect anyway.
      ...(options.keepIndex ? ['--keep-index'] : []),
      '--include-untracked',
      '--message',
      label,
      ...pathspec(paths),
    ],
    destructive: true,
    timeoutMs: 120_000,
  };
}

/** Lists stash entries in a machine-stable format. */
export function buildStashListCommand(): GitCommand {
  return {
    args: ['stash', 'list', '-z', '--format=%gd%x00%H%x00%aI%x00%gs'],
  };
}

/**
 * Resolves a stash ref to the commit it points at.
 *
 * Stash indices shift whenever anything is stashed — including this app's own
 * discard. Verifying the oid before dropping or popping is what stops a click
 * on the row the user was looking at from destroying a different entry.
 */
export function buildResolveStashCommand(ref: string): GitCommand {
  return {
    args: ['rev-parse', '--verify', '--quiet', `${assertRevision(ref)}^{commit}`],
  };
}

export function buildStashApplyCommand(
  ref: string,
  options: { pop: boolean },
): GitCommand {
  return {
    args: ['stash', options.pop ? 'pop' : 'apply', assertRevision(ref)],
    destructive: options.pop,
  };
}

export function buildStashDropCommand(ref: string): GitCommand {
  return { args: ['stash', 'drop', assertRevision(ref)], destructive: true };
}
