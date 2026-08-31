import { assertRefName } from '../argsafety';
import type { GitCommand } from '../types';

/**
 * Builders for network operations.
 *
 * Network commands get a much longer timeout than local ones: a fetch over a
 * slow link is not a hung process, and killing it at the default 30s would look
 * like a failure the user cannot explain.
 */
const NETWORK_TIMEOUT_MS = 300_000;

/** Lists remotes with both URLs, one line per direction. */
export function buildRemoteListCommand(): GitCommand {
  return { args: ['remote', '--verbose'] };
}

export interface FetchOptions {
  remote?: string;
  /** Removes local refs whose remote branch is gone. */
  prune?: boolean;
}

export function buildFetchCommand(options: FetchOptions = {}): GitCommand {
  const args = ['fetch', '--no-tags', '--progress'];
  if (options.prune === true) args.push('--prune');
  args.push(options.remote === undefined ? '--all' : assertRefName(options.remote));
  return { args, timeoutMs: NETWORK_TIMEOUT_MS };
}

/**
 * Pulls with `--ff-only`.
 *
 * A pull that can only fast-forward either succeeds cleanly or stops and says
 * why. The alternative — an implicit merge or rebase — makes a decision on the
 * user's behalf that can leave the repository mid-operation with conflicts they
 * did not ask for. Divergence is surfaced as an error and handled explicitly.
 */
export function buildPullCommand(): GitCommand {
  return { args: ['pull', '--ff-only', '--progress'], timeoutMs: NETWORK_TIMEOUT_MS };
}

export interface PushOptions {
  remote: string;
  branch: string;
  /** Publishes a branch that has no upstream yet. */
  setUpstream?: boolean;
  /**
   * Force with lease: refuses if the remote moved since our last fetch. Plain
   * `--force` is deliberately not offered anywhere in this app.
   *
   * Not safe to expose in the UI until the lease carries an explicit
   * `<branch>:<oid>` — the bare form leases against the local remote-tracking
   * ref, so it is only as fresh as the last fetch. Wire the oid the UI showed
   * the user at the same time as the confirmation dialog.
   */
  forceWithLease?: boolean;
}

export function buildPushCommand(options: PushOptions): GitCommand {
  const args = ['push', '--progress'];
  if (options.setUpstream === true) args.push('--set-upstream');
  if (options.forceWithLease === true) args.push('--force-with-lease');

  const branch = assertRefName(options.branch);
  args.push(assertRefName(options.remote));
  // An explicit, fully-qualified refspec. A bare branch token would let a name
  // like `+main` be read as a force refspec, and a name like `refs/heads/x`
  // resolve somewhere unintended.
  args.push(`refs/heads/${branch}:refs/heads/${branch}`);
  return {
    args,
    destructive: options.forceWithLease === true,
    timeoutMs: NETWORK_TIMEOUT_MS,
  };
}

/**
 * Publishes one tag to a remote.
 *
 * A tag is created locally and then exists nowhere else: `git push` does not
 * carry tags along with commits, which is why a release tag so often lives on
 * one laptop until somebody notices.
 *
 * Fully qualified on both sides, for the reason the branch push is: a tag named
 * `+v1.0` would otherwise be read as a force refspec, and one named
 * `refs/tags/x` would resolve somewhere nobody meant. Never `--force`: a tag
 * that already exists on the remote is a name other people have already
 * fetched, and moving it is the kind of edit that shows up in no diff. Git's
 * refusal is reported instead.
 */
export function buildPushTagCommand(remote: string, tag: string): GitCommand {
  const name = assertRefName(tag);
  return {
    args: [
      'push',
      '--progress',
      assertRefName(remote),
      `refs/tags/${name}:refs/tags/${name}`,
    ],
    timeoutMs: NETWORK_TIMEOUT_MS,
  };
}

/** Aborts an in-progress merge, returning the tree to its pre-merge state. */
export function buildMergeAbortCommand(): GitCommand {
  return { args: ['merge', '--abort'], destructive: true };
}
