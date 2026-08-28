/**
 * Operations offered on a single commit from the history panel.
 *
 * The rule that shapes this module: **rebase and reset act on whatever branch
 * HEAD is on, and the user chose them from a menu that named a branch.** Those
 * two facts are read at different moments. A checkout in another tab, a pull, a
 * finished operation from this same app — anything that moves HEAD between the
 * menu being drawn and the item being clicked would rewrite a branch the user
 * was never shown. So both re-read HEAD first and refuse when it is not the
 * branch the question was asked about. That is the same guard the stash list
 * uses for a shifted `stash@{n}`, for the same reason.
 */

import {
  buildCherryPickCommand,
  buildCurrentBranchCommand,
  buildMergeCommand,
  buildRebaseCommand,
  buildResetCommand,
  buildRevertCommand,
  buildTagCommand,
  type ResetMode,
} from './commands/history';
import { approve, type Confirmation } from './confirm';
import { GitError } from './errors';
import { runGit } from './runner';

/** Read-only and additive commands; nothing here can lose work. */
const SAFE = { confirmed: true } as const;

export type { ResetMode };

/** The branch HEAD is on, or `null` when HEAD is detached. */
export async function currentBranch(repo: string): Promise<string | null> {
  // Exit code 1 with empty output *is* the detached answer, not a failure.
  const output = await runGit(repo, buildCurrentBranchCommand(), {
    allowExitCodes: [1],
  });
  const name = output.stdout.trim();
  return name.length === 0 ? null : name;
}

/**
 * Refuses unless HEAD is still on `expected`.
 *
 * Named after what it protects: the branch the user read in the menu item.
 */
async function assertOnBranch(repo: string, expected: string): Promise<void> {
  const actual = await currentBranch(repo);
  if (actual === expected) return;
  throw new GitError(
    'command-failed',
    actual === null
      ? `This would have acted on "${expected}", but HEAD is no longer on a branch. Nothing was changed.`
      : `This would have acted on "${expected}", but HEAD is now on "${actual}". Nothing was changed.`,
    { args: ['symbolic-ref', 'HEAD'] },
  );
}

/** Creates a lightweight tag, or an annotated one when a message is given. */
export function createTag(
  repo: string,
  name: string,
  rev: string,
  options: { message?: string } = {},
): Promise<unknown> {
  return runGit(repo, buildTagCommand(name, rev, options), SAFE);
}

/** Replays `rev` on top of HEAD as a new commit. */
export function cherryPick(repo: string, rev: string): Promise<unknown> {
  return runGit(repo, buildCherryPickCommand(rev), SAFE);
}

/** Records a new commit undoing `rev`. */
export function revertCommit(repo: string, rev: string): Promise<unknown> {
  return runGit(repo, buildRevertCommand(rev), SAFE);
}

/**
 * What a merge did, once it stopped.
 *
 * `conflicted` is not a failure: git stopped where it always stops, the
 * repository is mid-merge, and the conflict panel is where the user finishes
 * the job. Reporting it as an error would be a lie the user then has to
 * reconcile with the banner appearing next to it.
 */
export type MergeOutcome = 'merged' | 'conflicted';

/**
 * Merges `rev` into `branch`.
 *
 * `branch` is the name the question named, and HEAD is re-read first: git
 * merges into whatever is checked out *now*, so a checkout that happened
 * between the question and the answer would merge into a branch the user was
 * never asked about.
 */
export async function mergeInto(
  repo: string,
  branch: string,
  rev: string,
  confirmation: Confirmation,
): Promise<MergeOutcome> {
  const gate = approve(confirmation);
  await assertOnBranch(repo, branch);

  // Exit code 1 is how git reports a conflict, and also how it reports several
  // ordinary refusals ("your local changes would be overwritten"). Allowing it
  // is what makes the two distinguishable at all; everything that is not
  // recognisably a conflict is re-thrown as the failure it is.
  const output = await runGit(repo, buildMergeCommand(rev), {
    ...gate,
    allowExitCodes: [1],
  });
  if (output.code === 0) return 'merged';

  const said = `${output.stdout}\n${output.stderr}`;
  if (/^CONFLICT|Automatic merge failed|fix conflicts/im.test(said)) return 'conflicted';

  throw new GitError('command-failed', mergeFailureMessage(said), {
    args: ['merge', rev],
    code: output.code,
    stderr: output.stderr,
  });
}

/** git's own first line, which says what it refused and why. */
function mergeFailureMessage(said: string): string {
  const line = said
    .split('\n')
    .map((text) => text.trim())
    .find((text) => text.length > 0);
  return line ?? 'The merge did not run, and git did not say why.';
}

/**
 * Replays `branch` onto `rev`. `branch` is the name the user was shown; the
 * rebase is abandoned before it starts if HEAD has moved off it.
 */
export async function rebaseOnto(
  repo: string,
  branch: string,
  rev: string,
  confirmation: Confirmation,
): Promise<void> {
  const gate = approve(confirmation);
  await assertOnBranch(repo, branch);
  await runGit(repo, buildRebaseCommand(rev), gate);
}

/** Moves `branch` to `rev`. Same HEAD guard, same reason. */
export async function resetTo(
  repo: string,
  branch: string,
  rev: string,
  mode: ResetMode,
  confirmation: Confirmation,
): Promise<void> {
  const gate = approve(confirmation);
  await assertOnBranch(repo, branch);
  await runGit(repo, buildResetCommand(rev, mode), gate);
}
