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
  buildPullMergeCommand,
  buildPushCommand,
  buildPushTagCommand,
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
import { classifyFailure, GitError } from './errors';
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
 * When the branches have diverged git refuses, and `classifyFailure` turns
 * that refusal into a `diverged` error the UI answers with the explicit
 * merge-pull ({@link pullMerge}) rather than a silent merge nobody chose.
 */
export async function pull(repo: string): Promise<void> {
  await runGit(repo, buildPullCommand(), SAFE);
}

/** How a merge-pull ended when it did not fail outright. */
export type PullMergeOutcome = 'pulled' | 'conflicted';

/**
 * Pulls with an explicit merge — the answer to a `diverged` refusal from
 * {@link pull}.
 *
 * Takes a {@link Confirmation} even though the command is not destructive:
 * this is the one operation that writes a merge commit the user did not
 * author, so it must not be reachable without them having read what it does.
 *
 * Exit code 1 is allowed for the reason `mergeInto` allows it: it is how git
 * reports a conflicted stop, which is an outcome the UI explains next to the
 * conflict banner, not a failure. The allowed exit is classified by the same
 * code that classifies a thrown one, so what counts as "conflicted" cannot
 * drift between the two paths; anything else is re-thrown as the failure it
 * is, with its real kind and arguments.
 */
export async function pullMerge(
  repo: string,
  confirmation: Confirmation,
): Promise<PullMergeOutcome> {
  const command = buildPullMergeCommand();
  const output = await runGit(repo, command, {
    ...approve(confirmation),
    allowExitCodes: [1],
  });
  if (output.code === 0) return 'pulled';

  const failure = classifyFailure(command.args, output);
  if (failure.kind === 'conflict') return 'conflicted';
  throw failure;
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

/**
 * Publishes one tag. Additive: it can create a ref on the remote and can never
 * move or delete one, so git's own refusal is the whole safety story.
 */
export function pushTag(repo: string, remote: string, tag: string): Promise<unknown> {
  return runGit(repo, buildPushTagCommand(remote, tag), SAFE);
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
