/**
 * Removing a worktree from its row on the timeline (ADR-0065).
 *
 * Its own module for the reason `stashDialog` is: the sentence the user agrees
 * to is the confirmation reason the git layer records, and the rule deciding
 * whether the item is reachable at all is about losing work, so it is pure and
 * asserted on its own.
 */

import type { RemoveWorktreeOutcome, WorktreeSummary } from '../../git/worktrees';
import { removeWorktreeAt } from '../../state/actions';
import type { Store } from '../../state/store';
import type { ConfirmDialog } from './CommitActions';
import { deleteBranchDialog } from './branchDialog';
import { worktreeName } from './worktreeRows';

/**
 * Why this worktree cannot be removed right now, or `null` when it can.
 *
 * A lock is somebody's explicit "not this one" — often a checkout on a drive
 * that is not plugged in — and the app does not override it. A tab with the
 * folder open is watching it, and on Windows that turns a remove into half a
 * remove. Uncommitted work is *not* a reason here: git refuses it on its own,
 * and that refusal is what the second, forcing question is built from.
 */
export function removeWorktreeRefusal(
  worktree: WorktreeSummary,
  options: { busy: boolean; openInTab: boolean },
): string | null {
  if (options.busy) return 'A git command is already running.';
  if (worktree.main) return 'This is the repository’s main worktree.';
  if (worktree.locked !== null) {
    return worktree.locked.length === 0
      ? 'This worktree is locked. Unlock it with git first.'
      : `This worktree is locked (${worktree.locked}). Unlock it with git first.`;
  }
  if (options.openInTab) return 'It is open in a tab. Close that tab first.';
  return null;
}

/**
 * What git does and does not check before the folder goes.
 *
 * Said in so many words because the safe form protects less than "git refuses
 * if anything is uncommitted" suggests: ignored files are not uncommitted work
 * to git, so a `.env` with secrets or a hand-tuned local config goes without a
 * question. That has to be on screen before the click, not discovered after.
 */
export const IGNORED_FILES_GO =
  'Git refuses this if a tracked or untracked file there has changes, but ignored files — a .env, node_modules, build output — are deleted without a check.';

/** The first question, and the confirmation reason it mints. */
export function removeWorktreeQuestion(worktree: WorktreeSummary): string {
  return `Remove the worktree "${worktreeName(worktree)}" and delete its folder, ${worktree.path}?`;
}

/** The second question, asked only after git refused because of uncommitted work. */
export function forceRemoveWorktreeQuestion(worktree: WorktreeSummary): string {
  return `Remove "${worktreeName(worktree)}" anyway, deleting the uncommitted work in ${worktree.path}?`;
}

/**
 * The remove question, the forced one it may turn into, and the branch delete
 * it is followed by.
 *
 * `branch` is the branch to offer deleting once the folder is gone — decided
 * by the caller from the lists as they stood when the menu opened (see
 * `branchAfterWorktreeRemove`) — or `null` to offer nothing.
 */
export function removeWorktreeDialog(
  store: Store,
  worktree: WorktreeSummary,
  branch: string | null,
): ConfirmDialog {
  const name = worktreeName(worktree);
  const followUp = (result: unknown): ConfirmDialog | null => {
    const outcome = result as RemoveWorktreeOutcome | null;
    if (outcome === null || !outcome.removed || branch === null) return null;
    return deleteBranchDialog(store, branch, `Also delete the local branch "${branch}"?`);
  };

  return {
    kind: 'confirm',
    title: `Remove worktree "${name}"?`,
    question: removeWorktreeQuestion(worktree),
    detail:
      worktree.branch === null
        ? `Its commits stay in this repository. ${IGNORED_FILES_GO}`
        : `The branch "${worktree.branch}" and its commits stay in this repository. ${IGNORED_FILES_GO}`,
    confirmLabel: 'Remove Worktree',
    danger: true,
    run: (reason) => removeWorktreeAt(store, worktree.path, reason, { force: false }),
    escalate: (result) => {
      const outcome = result as RemoveWorktreeOutcome | null;
      const warning = outcome?.uncommittedWarning;
      if (outcome === null || outcome.removed || warning === undefined) {
        return followUp(result);
      }
      return {
        kind: 'confirm',
        title: `Remove "${name}" anyway?`,
        question: forceRemoveWorktreeQuestion(worktree),
        detail: warning,
        confirmLabel: 'Remove Worktree',
        danger: true,
        arm: 'I understand the uncommitted work there will be lost',
        run: (reason) => removeWorktreeAt(store, worktree.path, reason, { force: true }),
        escalate: followUp,
      };
    },
  };
}
