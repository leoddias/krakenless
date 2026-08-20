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
   */
  forceWithLease?: boolean;
}

export function buildPushCommand(options: PushOptions): GitCommand {
  const args = ['push', '--progress'];
  if (options.setUpstream === true) args.push('--set-upstream');
  if (options.forceWithLease === true) args.push('--force-with-lease');
  args.push(assertRefName(options.remote), assertRefName(options.branch));
  return {
    args,
    destructive: options.forceWithLease === true,
    timeoutMs: NETWORK_TIMEOUT_MS,
  };
}

/** Aborts an in-progress merge, returning the tree to its pre-merge state. */
export function buildMergeAbortCommand(): GitCommand {
  return { args: ['merge', '--abort'], destructive: true };
}

/** Reads which operation the repository is in the middle of, if any. */
export function buildOperationProbeCommand(): GitCommand {
  return {
    args: [
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'MERGE_HEAD',
      '--git-path',
      'rebase-merge',
      '--git-path',
      'rebase-apply',
      '--git-path',
      'CHERRY_PICK_HEAD',
      '--git-path',
      'REVERT_HEAD',
      '--git-path',
      'BISECT_LOG',
    ],
  };
}
