import { assertPath, assertRevision, pathspec, pathspecInput } from '../argsafety';
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
  const { args, stdin } = pathspecInput(paths);
  return { args: ['add', ...args], ...(stdin === undefined ? {} : { stdin }) };
}

/**
 * Unstages whole paths. Uses `restore --staged`, which only rewrites the index
 * — the working tree keeps the user's edits either way.
 */
export function buildUnstageCommand(paths: string[]): GitCommand {
  const { args, stdin } = pathspecInput(paths);
  return {
    args: ['restore', '--staged', ...args],
    destructive: true,
    ...(stdin === undefined ? {} : { stdin }),
  };
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
 * Writes the current bytes of several files into the object store.
 *
 * One oid per path on stdout, in the order the paths were given. This is the
 * backup a whole-file discard takes *before* it removes anything (ADR-0045):
 * a loose blob on no ref, named only by the record the app keeps, and the
 * same route the hunk discard has used since ADR-0032. `--no-filters` stores
 * the bytes exactly as they are on disk, so the restore is byte-exact.
 * `--stdin-paths` reads one path per line — a path containing a newline
 * would be read as two, so it is refused here rather than half-backed-up.
 */
export function buildBackupBlobsCommand(paths: string[]): GitCommand {
  if (paths.length === 0) {
    throw new GitError('bad-argument', 'backup needs at least one path', {
      args: ['hash-object'],
    });
  }
  for (const path of paths) {
    assertPath(path);
    if (path.includes('\n') || path.includes('\r')) {
      throw new GitError(
        'bad-argument',
        `path contains a line break: ${JSON.stringify(path)}`,
        {
          args: ['hash-object'],
        },
      );
    }
  }
  return {
    args: ['hash-object', '-w', '--no-filters', '--stdin-paths'],
    stdin: `${paths.join('\n')}\n`,
  };
}

/**
 * Puts tracked paths back to their index version, on disk only.
 *
 * This is the discard itself for a tracked file: the staged snapshot, if any,
 * is what the working tree becomes, which is exactly "drop my unstaged edits".
 * A deleted file comes back the same way. Unrecoverable on its own — which is
 * why `discardPaths` only runs it after `buildBackupBlobsCommand` succeeded.
 */
export function buildRestoreWorktreeCommand(paths: string[]): GitCommand {
  const { args, stdin } = pathspecInput(paths);
  return {
    args: ['restore', '--worktree', ...args],
    destructive: true,
    ...(stdin === undefined ? {} : { stdin }),
  };
}

/**
 * Removes untracked files from disk — the discard for a file git never had.
 *
 * `clean` has no `--pathspec-from-file`, so the caller chunks a long list
 * (`chunkPathspec`); unlike a stash there is no half-done state between
 * chunks. No `-d`: the paths are files, and a directory would only be reached
 * through one of them being wrong.
 */
export function buildRemoveUntrackedCommand(paths: string[]): GitCommand {
  return { args: ['clean', '--force', ...pathspec(paths)], destructive: true };
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
