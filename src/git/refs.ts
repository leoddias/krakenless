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
  buildDeleteRemoteBranchCommand,
  buildDeleteRemoteTagCommand,
  buildPushCommand,
  buildPushTagCommand,
  buildRemoteListCommand,
  type FetchOptions,
  type PushOptions,
} from './commands/remote';
import { buildRefSnapshotCommand } from './commands/refsnapshot';
import { buildDeleteTagCommand, buildTagListCommand } from './commands/tag';
import {
  buildResolveStashCommand,
  buildStashApplyCommand,
  buildStashDropCommand,
  buildStashPushCommand,
  buildStashListCommand,
} from './commands/stage';
import { autostashConflictedIn } from './autostash';
import { approve, type Confirmation } from './confirm';
import { classifyFailure, GitError } from './errors';
import { parseBranches, parseRemotes, parseStashes } from './parsers/branch';
import { parseTags } from './parsers/tag';
import { parseRefSnapshot, type RefSnapshot } from './parsers/refsnapshot';
import { runGit } from './runner';
import type { Branch, Remote, StashEntry, Tag } from './types';

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

export async function listTags(repo: string): Promise<Tag[]> {
  const output = await runGit(repo, buildTagListCommand());
  return parseTags(output.stdout);
}

export async function listStashes(repo: string): Promise<StashEntry[]> {
  const output = await runGit(repo, buildStashListCommand());
  return parseStashes(output.stdout);
}

/**
 * Reads every remote-tracking ref and tag with the oid it points at.
 *
 * Taken either side of a fetch, two of these say exactly what arrived — which
 * is the difference between refreshing four panels because a timer fired and
 * refreshing them because something actually changed.
 */
export async function readRefSnapshot(repo: string): Promise<RefSnapshot> {
  const output = await runGit(repo, buildRefSnapshotCommand());
  return parseRefSnapshot(output.stdout);
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
/**
 * How a pull ended when git considered it a success.
 *
 * `autostash-conflicted` is the one that must never pass in silence: the pull
 * worked, git exited 0, and the working tree holds conflict markers with the
 * user's changes in a stash nobody mentioned (see `autostash.ts`).
 */
export type PullOutcome = 'pulled' | 'autostash-conflicted';

export async function pull(repo: string): Promise<PullOutcome> {
  const output = await runGit(repo, buildPullCommand(), SAFE);
  return autostashConflictedIn(output) ? 'autostash-conflicted' : 'pulled';
}

/** How a merge-pull ended when it did not fail outright. */
export type PullMergeOutcome = PullOutcome | 'conflicted';

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
  if (output.code === 0) {
    return autostashConflictedIn(output) ? 'autostash-conflicted' : 'pulled';
  }

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
  if (options.forceWithLease !== undefined) {
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
 * Deletes a branch on a remote, which is not undoable from here.
 *
 * Confirmed for the reason a lease push is: this is a ref other people fetch,
 * and it stops existing for all of them. The confirmation token is the only
 * gate — git will not refuse a delete of a branch that is merged nowhere, and
 * the server's own protections (a default branch, a protected pattern) are the
 * only other thing standing in the way.
 */
export function deleteRemoteBranch(
  repo: string,
  remote: string,
  branch: string,
  confirmation: Confirmation,
): Promise<unknown> {
  return runGit(
    repo,
    buildDeleteRemoteBranchCommand(remote, branch),
    approve(confirmation),
  );
}

/**
 * How a remote tag delete ended when git considered it a success.
 *
 * `nothing-there` is the outcome that must never pass as `deleted`: pushing a
 * delete for a tag the remote does not have exits **0** and prints
 * `- [deleted] v9.9`, with only a `warning: deleting a non-existent ref` from
 * the receiving end to say otherwise. Reported as success it would tell the
 * user a release tag is gone from the server while it is sitting there under a
 * name they misspelled.
 */
export type RemoteTagDeleteOutcome = 'deleted' | 'nothing-there';

/**
 * Deletes a tag on a remote, which is not undoable from here.
 *
 * Confirmed for the reason the remote branch delete is: this is a ref other
 * people fetch by name, and a release tag is fetched by scripts as well as by
 * people. Git offers no refusal to lean on — a tag is never "merged" — so the
 * confirmation token is the only gate before the server's own.
 */
export async function deleteRemoteTag(
  repo: string,
  remote: string,
  tag: string,
  confirmation: Confirmation,
): Promise<RemoteTagDeleteOutcome> {
  const output = await runGit(
    repo,
    buildDeleteRemoteTagCommand(remote, tag),
    approve(confirmation),
  );
  // Read from the output for the reason the autostash conflict is: git exited
  // 0, and the only thing separating "done" from "there was nothing to do" is
  // a line it wrote on the way past. A server that errors instead (most do
  // over ssh or https) has already come back as a failure.
  return /deleting a non-existent ref/i.test(`${output.stdout}\n${output.stderr}`)
    ? 'nothing-there'
    : 'deleted';
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

/**
 * Deletes a tag locally.
 *
 * One step, unlike a branch delete, because git has no two: `tag -d` has no
 * safe form to try first and no refusal to escalate from — "merged" means
 * nothing about a tag. So the whole gate is the confirmation the caller took,
 * plus the fact that the ref is all that goes: the object it named survives
 * until git collects it, and `git update-ref refs/tags/<name> <object>` puts
 * the tag back exactly as it was, annotation and all.
 */
export function deleteTag(
  repo: string,
  name: string,
  confirmation: Confirmation,
): Promise<unknown> {
  return runGit(repo, buildDeleteTagCommand(name), approve(confirmation));
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

/**
 * Puts the working tree aside as a new stash entry.
 *
 * Confirmed like every other stash operation: the work leaves the working tree,
 * and a user who did not ask for that would find their edits gone with no diff
 * to explain it. Recoverable by design — the entry is in the stash list the app
 * already shows, and `git stash pop` is one click away — which is why this asks
 * rather than refuses.
 *
 * Tracked changes only — see {@link buildStashPushCommand} for why untracked
 * files are not offered here. They stay on disk, which is also what plain
 * `git stash` does.
 *
 * `git stash push` on a clean tree exits 0 and creates nothing. The caller is
 * responsible for not offering it there; this does not second-guess the status
 * it was given, because a status read and a stash are two moments and a file
 * can change between them.
 */
export async function stashWorkingTree(
  repo: string,
  options: { message?: string },
  confirmation: Confirmation,
): Promise<void> {
  await runGit(repo, buildStashPushCommand(options), approve(confirmation));
}

export async function dropStash(
  repo: string,
  entry: { ref: string; oid: string },
  confirmation: Confirmation,
): Promise<void> {
  await assertStashUnchanged(repo, entry.ref, entry.oid);
  await runGit(repo, buildStashDropCommand(entry.ref), approve(confirmation));
}
