/**
 * Reading the repository's worktrees, and how much is uncommitted in each.
 *
 * A linked worktree is a checkout the app can see but is not standing in: its
 * files, its index and its HEAD are its own, and nothing the filesystem watcher
 * hears about this repository says a word about them. So the count of what is
 * uncommitted over there has to be asked for, one `git status` per worktree,
 * run *in* that worktree — which is all it takes, because `git` resolves the
 * shared `.git` from wherever it is invoked.
 *
 * Two things here write: {@link removeWorktree} (ADR-0065), which takes a
 * finished checkout off disk, and {@link switchTakingBranch} (ADR-0068), which
 * detaches another worktree's HEAD so this one can check out its branch. Adding one is still not built (ADR-0027).
 */

import { buildSwitchCommand } from './commands/branch';
import { buildRepoProbeCommand } from './commands/repo';
import {
  buildBisectLogCommand,
  buildDetachHeadCommand,
  buildHeadRefCommand,
  buildWorktreeListCommand,
  buildWorktreeRemoveCommand,
} from './commands/worktree';
import { approve, type Confirmation } from './confirm';
import { GitError } from './errors';
import { readOperation } from './operation';
import { parseRepoProbe } from './parsers/repo';
import { parseWorktrees } from './parsers/worktree';
import { runGit } from './runner';
import { getStatus } from './status';
import type { RepoStatus, Worktree } from './types';

/** A switch, or a detach at the commit already checked out: nothing can be lost. */
const SAFE = { confirmed: true } as const;

/** A worktree plus what is uncommitted in it, when that could be read. */
export interface WorktreeSummary extends Worktree {
  /**
   * Tracked files changed in the index or on disk, and files git does not know
   * about yet. `null` for both when the status could not be read — a worktree
   * whose directory is gone is the ordinary case, and a zero there would be a
   * confident lie about a checkout nobody can see.
   */
  changed: number | null;
  untracked: number | null;
}

/** Lists the worktrees, main one first. */
export async function listWorktrees(repo: string): Promise<Worktree[]> {
  const output = await runGit(repo, buildWorktreeListCommand());
  return parseWorktrees(output.stdout);
}

/** How many files are changed and how many are untracked, from one status. */
export function countChanges(status: RepoStatus): {
  changed: number;
  untracked: number;
} {
  let changed = 0;
  let untracked = 0;
  for (const entry of status.entries) {
    if (entry.index === 'untracked' || entry.worktree === 'untracked') {
      untracked += 1;
      continue;
    }
    if (entry.index === 'ignored' || entry.worktree === 'ignored') continue;
    changed += 1;
  }
  return { changed, untracked };
}

/**
 * Lists the worktrees and counts what is uncommitted in each.
 *
 * The statuses are read in parallel and every failure is absorbed into a `null`
 * count: a locked worktree on a disconnected drive, a directory somebody
 * deleted by hand, a path that needs a permission this process does not have —
 * none of those is a reason to leave the *list* unread, which is the part the
 * user came for.
 *
 * `skip` is the worktree the app is already standing in: its uncommitted work
 * is what the whole rest of the window is about, and re-reading it here would
 * be a second answer to a question already on screen.
 */
export async function listWorktreeSummaries(
  repo: string,
  options: { skip?: string } = {},
): Promise<WorktreeSummary[]> {
  const worktrees = await listWorktrees(repo);

  return Promise.all(
    worktrees.map(async (worktree) => {
      const blank = { ...worktree, changed: null, untracked: null };
      if (worktree.bare) return blank;
      if (worktree.prunable !== null) return blank;
      if (options.skip !== undefined && samePath(worktree.path, options.skip)) {
        return blank;
      }
      try {
        return { ...worktree, ...countChanges(await getStatus(worktree.path)) };
      } catch {
        return blank;
      }
    }),
  );
}

/**
 * Whether two paths name the same directory.
 *
 * Separators and case only: git prints forward slashes on Windows while the
 * rest of the app carries whatever the picker returned, and `C:/Repos/App` and
 * `c:/repos/app` are one directory there. This is the same comparison the tab
 * list makes (ADR-0023), and deliberately wrong in the same safe direction on a
 * case-sensitive filesystem — one match too many, never one too few.
 */
export function samePath(left: string, right: string): boolean {
  const normalise = (path: string): string =>
    path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return normalise(left) === normalise(right);
}

export interface RemoveWorktreeOutcome {
  removed: boolean;
  /** Set when the safe remove refused because something there is uncommitted. */
  uncommittedWarning?: string;
}

/**
 * Removes a linked worktree, trying the safe form first.
 *
 * The same shape as a branch delete: without `force`, git refuses a worktree
 * holding modified or untracked files (ignored ones are not asked about and
 * go with the folder), and that refusal comes back as a
 * warning rather than being retried with `--force` — losing that work is a
 * second decision, made with the warning in view.
 *
 * Refused here, before git is asked, for the worktree the command would run
 * in: removing the checkout this process is standing in pulls the floor out
 * from under every panel reading it.
 */
export async function removeWorktree(
  repo: string,
  path: string,
  confirmation: Confirmation,
  options: { force: boolean } = { force: false },
): Promise<RemoveWorktreeOutcome> {
  const gate = approve(confirmation);
  const command = buildWorktreeRemoveCommand(path, options);
  if (samePath(path, repo)) {
    throw new GitError('bad-argument', 'This is the worktree the app has open', {
      args: command.args,
    });
  }
  if (options.force) {
    await runGit(repo, command, gate);
    return { removed: true };
  }

  try {
    await runGit(repo, command, gate);
    return { removed: true };
  } catch (error) {
    if (
      error instanceof GitError &&
      /contains modified or untracked files/i.test(error.stderr)
    ) {
      return {
        removed: false,
        uncommittedWarning: `The worktree at ${path} has changes that are not committed. Removing it anyway deletes them, and git keeps no copy.`,
      };
    }
    throw error;
  }
}

/** What a switch had to do in another worktree to get its branch. */
export interface SwitchOutcome {
  /** The worktree that was holding the branch and is now detached, or `null`. */
  freedFrom: string | null;
}

/**
 * Switches `repo` to `name`, taking the branch from another worktree that has
 * it checked out (ADR-0068).
 *
 * Git refuses to check out a branch another worktree is on, and the refusal is
 * a dead end in a GUI: the other checkout is often one nobody is looking at.
 * So the holder is detached at the commit it already has — no file, no index
 * entry, no uncommitted change moves there, and the branch still points where
 * it did — and the switch runs here.
 *
 * Not taken, and git's own refusal stands, when the holder:
 * - is **locked**: a lock is somebody saying "leave this one alone";
 * - is **prunable**: its directory is gone, so there is nothing to detach;
 * - is **in the middle of a rebase, merge, cherry-pick or revert**: detaching
 *   there would strand the operation, and a commit finishing it would land on
 *   no branch.
 *
 * If the switch here then fails — uncommitted work here that the switch would
 * overwrite is the usual reason — the holder is put back on the branch before
 * the error is passed on. That cannot move a file either: its HEAD is still
 * the branch's commit, because a refused switch moves no ref.
 */
export async function switchTakingBranch(
  repo: string,
  name: string,
): Promise<SwitchOutcome> {
  const switchHere = buildSwitchCommand(name);
  // Already here: nothing to take. Asked of this checkout rather than decided
  // from the list, because the path the app opened and the path git prints can
  // differ (a junction, a subst drive) and this checkout would otherwise be
  // mistaken for its own holder.
  if ((await headRef(repo)) === `refs/heads/${name}`) return { freedFrom: null };
  const worktrees = await listWorktrees(repo);
  const holder = worktrees.find(
    (worktree) => worktree.branch === name && !samePath(worktree.path, repo),
  );
  if (holder === undefined) {
    await runGit(repo, switchHere, SAFE);
    return { freedFrom: null };
  }

  const refuse = (why: string): never => {
    throw new GitError(
      'command-failed',
      `"${name}" is checked out in ${holder.path}, ${why}`,
      { args: switchHere.args },
    );
  };
  if (holder.locked !== null) {
    refuse(
      `which is locked${holder.locked === '' ? '' : ` (${holder.locked})`}. Unlock it or switch it to another branch first.`,
    );
  }
  if (holder.prunable !== null) {
    refuse(
      `which git cannot reach (${holder.prunable}). Run "git worktree prune" to forget it, then try again.`,
    );
  }

  // That worktree's own git dir: a linked worktree keeps its HEAD, and its
  // rebase or merge state, under `.git/worktrees/<name>`, not in this one's.
  const probe = await runGit(holder.path, buildRepoProbeCommand());
  const operation = await readOperation(holder.path, parseRepoProbe(probe.stdout).gitDir);
  if (operation.kind !== null) {
    refuse(
      `which is in the middle of a ${operation.kind}. Finish or abort it there first.`,
    );
  }
  const bisect = await runGit(holder.path, buildBisectLogCommand(), {
    ...SAFE,
    allowExitCodes: [1],
  });
  if (bisect.code === 0) {
    refuse('which is in the middle of a bisect. Run "git bisect reset" there first.');
  }
  // Read again at the last moment, *in* that directory: the list is a moment
  // old and somebody — often an agent — may have switched it since. Detaching
  // a worktree that is no longer on the branch would change it for nothing,
  // and putting it "back" afterwards would put it somewhere it never was.
  if ((await headRef(holder.path)) !== `refs/heads/${name}`) {
    await runGit(repo, switchHere, SAFE);
    return { freedFrom: null };
  }

  await runGit(holder.path, buildDetachHeadCommand(), SAFE);
  try {
    await runGit(repo, switchHere, SAFE);
  } catch (error) {
    try {
      await runGit(holder.path, buildSwitchCommand(name), SAFE);
    } catch {
      // Left detached at the branch's commit, which loses nothing — but the
      // user has to hear that the other worktree changed, so it is added to
      // the switch's own reason rather than swallowed.
      const why = error instanceof Error ? error.message : String(error);
      throw new GitError(
        'command-failed',
        `${why}\n${holder.path} was left detached at the same commit; run "git switch ${name}" there to put it back.`,
        { args: switchHere.args },
      );
    }
    throw error;
  }
  return { freedFrom: holder.path };
}

/** The full ref HEAD is on in `cwd`, or `null` when it is detached. */
async function headRef(cwd: string): Promise<string | null> {
  const output = await runGit(cwd, buildHeadRefCommand(), { allowExitCodes: [1] });
  const ref = output.stdout.trim();
  return output.code === 0 && ref.length > 0 ? ref : null;
}
