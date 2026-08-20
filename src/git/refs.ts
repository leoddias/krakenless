import {
  buildBranchListCommand,
  buildCheckoutRevisionCommand,
  buildCreateBranchCommand,
  buildDeleteBranchCommand,
  buildSwitchCommand,
  buildSwitchNewCommand,
} from './commands/branch';
import {
  buildFetchCommand,
  buildMergeAbortCommand,
  buildPullCommand,
  buildPushCommand,
  buildRemoteListCommand,
  type FetchOptions,
  type PushOptions,
} from './commands/remote';
import {
  buildStashApplyCommand,
  buildStashDropCommand,
  buildStashListCommand,
} from './commands/stage';
import { GitError } from './errors';
import { parseBranches, parseRemotes, parseStashes } from './parsers/branch';
import { runGit } from './runner';
import type { Branch, Remote, StashEntry } from './types';

const CONFIRMED = { confirmed: true } as const;

// --- reads -----------------------------------------------------------------

export async function listBranches(
  repo: string,
  options: { includeRemotes?: boolean } = {},
): Promise<Branch[]> {
  const output = await runGit(repo, buildBranchListCommand(options));
  return parseBranches(output.stdout);
}

export async function listRemotes(repo: string): Promise<Remote[]> {
  const output = await runGit(repo, buildRemoteListCommand());
  return parseRemotes(output.stdout);
}

export async function listStashes(repo: string): Promise<StashEntry[]> {
  const output = await runGit(repo, buildStashListCommand());
  return parseStashes(output.stdout);
}

// --- network ---------------------------------------------------------------

export function fetch(repo: string, options: FetchOptions = {}): Promise<unknown> {
  return runGit(repo, buildFetchCommand(options), CONFIRMED);
}

/**
 * Pulls, fast-forward only.
 *
 * When the branches have diverged git refuses, and that refusal is turned into
 * a message the user can act on rather than a silent merge they did not choose.
 */
export async function pull(repo: string): Promise<void> {
  try {
    await runGit(repo, buildPullCommand(), CONFIRMED);
  } catch (error) {
    if (
      error instanceof GitError &&
      /not possible to fast-forward|diverg/i.test(error.stderr)
    ) {
      throw new GitError(
        'command-failed',
        'Your branch and its upstream have diverged. Merge or rebase explicitly to continue.',
        { args: error.args, code: error.code, stderr: error.stderr },
      );
    }
    throw error;
  }
}

export function push(repo: string, options: PushOptions): Promise<unknown> {
  return runGit(repo, buildPushCommand(options), CONFIRMED);
}

export function abortMerge(repo: string): Promise<unknown> {
  return runGit(repo, buildMergeAbortCommand(), CONFIRMED);
}

// --- branches --------------------------------------------------------------

export function createBranch(
  repo: string,
  name: string,
  startPoint?: string,
): Promise<unknown> {
  return runGit(repo, buildCreateBranchCommand(name, startPoint), CONFIRMED);
}

export function switchBranch(repo: string, name: string): Promise<unknown> {
  return runGit(repo, buildSwitchCommand(name), CONFIRMED);
}

export function switchNewBranch(
  repo: string,
  name: string,
  startPoint?: string,
): Promise<unknown> {
  return runGit(repo, buildSwitchNewCommand(name, startPoint), CONFIRMED);
}

export function checkoutRevision(repo: string, rev: string): Promise<unknown> {
  return runGit(repo, buildCheckoutRevisionCommand(rev), CONFIRMED);
}

export interface DeleteBranchOutcome {
  deleted: boolean;
  /** Set when the safe delete refused because the branch is not merged. */
  unmergedWarning?: string;
}

/**
 * Deletes a branch, trying the safe form first.
 *
 * `-d` refuses to drop commits that are not merged anywhere. That refusal is
 * reported back rather than retried with `-D`: forcing is a separate decision
 * the user has to make with the warning in front of them.
 */
export async function deleteBranch(
  repo: string,
  name: string,
  options: { force: boolean } = { force: false },
): Promise<DeleteBranchOutcome> {
  if (options.force) {
    await runGit(repo, buildDeleteBranchCommand(name, { force: true }), CONFIRMED);
    return { deleted: true };
  }

  try {
    await runGit(repo, buildDeleteBranchCommand(name, { force: false }), CONFIRMED);
    return { deleted: true };
  } catch (error) {
    if (error instanceof GitError && /not fully merged/i.test(error.stderr)) {
      return {
        deleted: false,
        unmergedWarning: `Branch "${name}" has commits that are not merged anywhere. Deleting it will drop them.`,
      };
    }
    throw error;
  }
}

// --- stash -----------------------------------------------------------------

export function applyStash(
  repo: string,
  ref: string,
  options: { pop: boolean },
): Promise<unknown> {
  return runGit(repo, buildStashApplyCommand(ref, options), CONFIRMED);
}

export function dropStash(repo: string, ref: string): Promise<unknown> {
  return runGit(repo, buildStashDropCommand(ref), CONFIRMED);
}
