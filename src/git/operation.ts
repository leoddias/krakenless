/**
 * Which operation the repository is stopped in the middle of, and how to end it.
 *
 * This module exists because the app used to assume the answer. Every conflict
 * was treated as a merge: the banner said "merge", and the only way out it
 * offered ran `git merge --abort`. During a rebase that fails —
 * "There is no merge to abort (MERGE_HEAD missing)" — and the user is left
 * stopped mid-rebase, on a detached HEAD, with nothing in the UI that can move
 * them forwards or backwards. That is the worst state a Git client can put
 * somebody in, and it is what this module is for.
 *
 * Detection order matters. A rebase that stops on a conflict writes *both*
 * `REBASE_HEAD` and, for the merge backend, a `MERGE_HEAD` — so asking about
 * merges first would answer "merge" for a rebase, which is the original bug
 * with extra steps. The rebase directory is checked first, and it is the
 * authority.
 */

import { invoke } from '@tauri-apps/api/core';
import {
  buildAbortCommand,
  buildContinueCommand,
  buildRefExistsCommand,
  buildSkipCommand,
  isContinuable,
  type ContinuableKind,
  type OperationKind,
} from './commands/operation';
import { approve, type Confirmation } from './confirm';
import { readLog } from './log';
import { runGit } from './runner';

export type { ContinuableKind, OperationKind };
export { isContinuable };

/** What git reports about a stopped rebase, from its own state files. */
interface RebaseProgress {
  in_progress: boolean;
  current: number | null;
  total: number | null;
  head_name: string | null;
  onto: string | null;
  interactive: boolean;
}

export interface Operation {
  kind: OperationKind | null;
  /** Commit being replayed, when there is one — `REBASE_HEAD` and friends. */
  commit: { oid: string; subject: string } | null;
  /** 1-based position in the rebase, when git recorded it. */
  step: number | null;
  /** How many commits the rebase replays in total. */
  steps: number | null;
  /** Branch being rebased, without `refs/heads/`. */
  branch: string | null;
}

/** Nothing in progress: the ordinary state, and the one with no way out to offer. */
export function noOperation(): Operation {
  return { kind: null, commit: null, step: null, steps: null, branch: null };
}

/** Whether a pseudo-ref resolves. Absence is exit code 1, not a failure. */
async function refExists(
  repo: string,
  ref: 'MERGE_HEAD' | 'CHERRY_PICK_HEAD' | 'REVERT_HEAD' | 'REBASE_HEAD',
): Promise<string | null> {
  const output = await runGit(repo, buildRefExistsCommand(ref), {
    allowExitCodes: [1, 128],
  });
  const oid = output.stdout.trim();
  return output.code === 0 && oid.length > 0 ? oid : null;
}

/**
 * One-line summary of a commit, for naming what the user is stopped on.
 *
 * A failure comes back as an empty subject rather than throwing: this banner's
 * whole job is to be there when things have gone sideways, and it must not
 * vanish because one `git log` could not be read.
 */
async function subjectOf(repo: string, oid: string): Promise<string> {
  try {
    const commits = await readLog(repo, { limit: 1, rev: oid });
    return commits[0]?.subject ?? '';
  } catch {
    return '';
  }
}

/**
 * Reads what the repository is in the middle of.
 *
 * `gitDir` is asked for rather than derived: a linked worktree's `.git` is a
 * file pointing elsewhere, and the rebase state lives at the end of that
 * pointer. The repository info the app already holds carries the resolved path.
 */
export async function readOperation(repo: string, gitDir: string): Promise<Operation> {
  const rebase = await readRebaseProgress(gitDir);

  if (rebase.in_progress) {
    const oid = await refExists(repo, 'REBASE_HEAD');
    return {
      kind: 'rebase',
      commit: oid === null ? null : { oid, subject: await subjectOf(repo, oid) },
      step: rebase.current,
      steps: rebase.total,
      branch: rebase.head_name,
    };
  }

  // Order is not alphabetical and not arbitrary: a cherry-pick and a revert
  // each write their own head, and a plain merge is what is left.
  for (const [ref, kind] of [
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
    ['MERGE_HEAD', 'merge'],
  ] as const) {
    const oid = await refExists(repo, ref);
    if (oid === null) continue;
    return {
      kind,
      commit: { oid, subject: await subjectOf(repo, oid) },
      step: null,
      steps: null,
      branch: null,
    };
  }

  return noOperation();
}

/**
 * Asks the Rust side for the rebase counters.
 *
 * A failure here is reported as "no rebase" rather than thrown: the counters
 * are a courtesy, and the pseudo-refs below still answer the question that
 * decides which commands the UI may offer.
 */
async function readRebaseProgress(gitDir: string): Promise<RebaseProgress> {
  try {
    return await invoke<RebaseProgress>('rebase_state', { gitDir });
  } catch {
    return {
      in_progress: false,
      current: null,
      total: null,
      head_name: null,
      onto: null,
      interactive: false,
    };
  }
}

/**
 * Resumes a stopped operation. The caller must have staged the resolutions —
 * git refuses otherwise, and says so.
 */
export function continueOperation(
  repo: string,
  kind: ContinuableKind,
  confirmation: Confirmation,
): Promise<unknown> {
  return runGit(repo, buildContinueCommand(kind), approve(confirmation));
}

/** Drops the commit the operation is stopped on and moves to the next. */
export function skipOperation(
  repo: string,
  kind: ContinuableKind,
  confirmation: Confirmation,
): Promise<unknown> {
  return runGit(repo, buildSkipCommand(kind), approve(confirmation));
}

/** Abandons the operation, putting the repository back where it started. */
export function abortOperation(
  repo: string,
  kind: OperationKind,
  confirmation: Confirmation,
): Promise<unknown> {
  return runGit(repo, buildAbortCommand(kind), approve(confirmation));
}
