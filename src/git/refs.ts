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
  buildResolveStashCommand,
  buildStashApplyCommand,
  buildStashDropCommand,
  buildStashListCommand,
} from './commands/stage';
import { approve, type Confirmation } from './confirm';
import { GitError } from './errors';
import { parseBranches, parseRemotes, parseStashes } from './parsers/branch';
import { runGit } from './runner';
import type { Branch, Remote, StashEntry } from './types';

/** Read-only and additive commands; nothing here can lose work. */
const SAFE = { confirmed: true } as const;

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
  return runGit(repo, buildFetchCommand(options), SAFE);
}

/**
 * Pulls, fast-forward only.
 *
 * When the branches have diverged git refuses, and that refusal is turned into
 * a message the user can act on rather than a silent merge they did not choose.
 */
export async function pull(repo: string): Promise<void> {
  try {
    await runGit(repo, buildPullCommand(), SAFE);
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

/**
 * Pushes. A lease push needs a {@link Confirmation}: it is the one operation
 * here that can destroy work belonging to *other people*, so it must not be
 * reachable without the user having been asked.
 */
export async function push(
  repo: string,
  options: PushOptions,
  confirmation?: Confirmation,
): Promise<unknown> {
  if (options.forceWithLease === true) {
    if (confirmation === undefined) {
      throw new GitError(
        'needs-confirmation',
        'A force push must be confirmed by the user first',
        { args: ['push'] },
      );
    }
    return runGit(repo, buildPushCommand(options), approve(confirmation));
  }
  return runGit(repo, buildPushCommand(options), SAFE);
}

export function abortMerge(repo: string, confirmation: Confirmation): Promise<unknown> {
  return runGit(repo, buildMergeAbortCommand(), approve(confirmation));
}

// --- branches --------------------------------------------------------------

export function createBranch(
  repo: string,
  name: string,
  startPoint?: string,
): Promise<unknown> {
  return runGit(repo, buildCreateBranchCommand(name, startPoint), SAFE);
}

export function switchBranch(repo: string, name: string): Promise<unknown> {
  return runGit(repo, buildSwitchCommand(name), SAFE);
}

export function switchNewBranch(
  repo: string,
  name: string,
  startPoint?: string,
): Promise<unknown> {
  return runGit(repo, buildSwitchNewCommand(name, startPoint), SAFE);
}

export function checkoutRevision(repo: string, rev: string): Promise<unknown> {
  return runGit(repo, buildCheckoutRevisionCommand(rev), SAFE);
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
  confirmation: Confirmation,
  options: { force: boolean } = { force: false },
): Promise<DeleteBranchOutcome> {
  const gate = approve(confirmation);
  if (options.force) {
    await runGit(repo, buildDeleteBranchCommand(name, { force: true }), gate);
    return { deleted: true };
  }

  try {
    await runGit(repo, buildDeleteBranchCommand(name, { force: false }), gate);
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

/**
 * Confirms `ref` still points at `expectedOid` before touching it.
 *
 * Stash indices shift on every push — including this app's own discard — so a
 * click on `stash@{0}` can land on an entry the user never saw. The list hands
 * back the oid it displayed; if the ref moved, nothing is touched.
 */
async function assertStashUnchanged(
  repo: string,
  ref: string,
  expectedOid: string,
): Promise<void> {
  const output = await runGit(repo, buildResolveStashCommand(ref), {
    allowExitCodes: [1],
  });
  const actual = output.stdout.trim();
  if (actual !== expectedOid) {
    throw new GitError(
      'command-failed',
      'The stash list changed since it was loaded. Refresh and try again.',
      { args: [ref] },
    );
  }
}

export async function applyStash(
  repo: string,
  entry: { ref: string; oid: string },
  options: { pop: boolean },
  confirmation: Confirmation,
): Promise<void> {
  await assertStashUnchanged(repo, entry.ref, entry.oid);
  await runGit(repo, buildStashApplyCommand(entry.ref, options), approve(confirmation));
}

export async function dropStash(
  repo: string,
  entry: { ref: string; oid: string },
  confirmation: Confirmation,
): Promise<void> {
  await assertStashUnchanged(repo, entry.ref, entry.oid);
  await runGit(repo, buildStashDropCommand(entry.ref), approve(confirmation));
}
