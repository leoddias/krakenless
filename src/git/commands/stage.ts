import { assertRevision, pathspec } from '../argsafety';
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
  return { args: ['add', '--', ...pathspec(paths).slice(1)] };
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
export function buildApplyCachedCommand(options: { reverse: boolean }): GitCommand {
  const args = ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn'];
  if (options.reverse) args.push('--reverse');
  // The patch itself arrives on stdin; `-` tells git to read it from there.
  args.push('-');
  return { args, destructive: options.reverse };
}

/** Dry run of the same patch. Used to refuse a patch before it can half-apply. */
export function buildApplyCheckCommand(options: { reverse: boolean }): GitCommand {
  const args = ['apply', '--cached', '--check', '--unidiff-zero', '--whitespace=nowarn'];
  if (options.reverse) args.push('--reverse');
  args.push('-');
  return { args };
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
 * recoverable with `git stash pop` — verified against git 2.39: other files'
 * edits and untracked files outside the pathspec are left alone. `git restore`
 * would do the same job with no way back, which fails the safety bar: a
 * mis-click must cost a `stash pop`, not the user's work.
 */
export function buildDiscardCommand(paths: string[], label: string): GitCommand {
  return {
    args: [
      'stash',
      'push',
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
