/**
 * The local branch delete as a dialog, and which branch to offer it for once
 * something else has gone.
 *
 * Its own module because three questions end in it: "Delete branch" on a
 * commit row, the question after a remote branch is deleted, and the one after
 * a worktree is removed (ADR-0066). A branch delete has a second, forced step
 * with its own reason, and three copies of that chain is how one of them ends
 * up forcing without the warning.
 */

import type { Branch } from '../../git/types';
import type { WorktreeSummary } from '../../git/worktrees';
import { samePath } from '../../git/worktrees';
import type { DeleteBranchOutcome } from '../../git/refs';
import { removeBranch } from '../../state/actions';
import type { Loadable, Store } from '../../state/store';
import { deleteBranchQuestion, forceDeleteBranchQuestion } from '../refs/labels';
import type { ConfirmDialog } from './CommitActions';
import { localStandIn } from './remoteSwitch';

/**
 * The safe branch delete, and the forced one it may turn into.
 *
 * Two steps and never one, and the second is a different question with a
 * different reason: git's refusal names commits that exist nowhere else, and
 * the token the `-D` records must be the yes the user gave *after* reading
 * that. The question strings are the refs panel's own, so the places that can
 * delete a branch cannot describe it differently. `title` is only the heading:
 * a follow-up question reads "Also delete…", and the reason stays the same.
 */
export function deleteBranchDialog(
  store: Store,
  name: string,
  title = `Delete branch "${name}"?`,
): ConfirmDialog {
  return {
    kind: 'confirm',
    title,
    question: deleteBranchQuestion(name),
    detail:
      'Commits that are merged elsewhere stay in the repository; git refuses this if any of them would be lost.',
    confirmLabel: 'Delete Branch',
    danger: true,
    run: (reason) => removeBranch(store, name, reason, { force: false }),
    escalate: (result) => {
      const outcome = result as DeleteBranchOutcome | null;
      if (outcome === null || outcome.deleted) return null;
      const warning = outcome.unmergedWarning;
      if (warning === undefined) return null;
      return {
        kind: 'confirm',
        title: `Delete "${name}" anyway?`,
        question: forceDeleteBranchQuestion(name),
        detail: warning,
        confirmLabel: 'Delete Branch',
        danger: true,
        arm: 'I understand those commits will be lost',
        run: (reason) => removeBranch(store, name, reason, { force: true }),
      };
    },
  };
}

/**
 * Whether a local branch can be offered for deletion at all.
 *
 * Not the one checked out here, which git refuses to delete, and not one
 * checked out in another worktree, which git refuses too — offering a question
 * whose only answer is git's refusal is noise. `leaving` is a worktree that is
 * about to stop holding it, the one just removed.
 */
function deletable(
  branch: Branch,
  worktrees: Loadable<WorktreeSummary[]>,
  leaving: string | null,
): boolean {
  if (branch.current) return false;
  if (worktrees.state !== 'ready') return true;
  return !worktrees.value.some(
    (worktree) =>
      worktree.branch === branch.name &&
      (leaving === null || !samePath(worktree.path, leaving)),
  );
}

/**
 * The local branch to offer deleting after `remoteRef` was deleted on its
 * remote, or `null`.
 *
 * The branch that stands for it by the rule a double click on that chip uses —
 * the one tracking it, else a namesake that tracks nothing else — so "the
 * local `x`" means the same thing everywhere in the app. Read *before* the
 * remote delete: the push removes the remote-tracking ref the rule looks at.
 */
export function localBranchAfterRemoteDelete(
  remoteRef: string,
  branches: Loadable<Branch[]>,
  worktrees: Loadable<WorktreeSummary[]>,
): string | null {
  if (branches.state !== 'ready') return null;
  const local = localStandIn(remoteRef, branches.value);
  return local !== undefined && deletable(local, worktrees, null) ? local.name : null;
}

/**
 * The branch to offer deleting after `worktree` was removed, or `null`.
 *
 * The one it had checked out, if that is a local branch nothing else holds. A
 * detached worktree has no branch to offer.
 */
export function branchAfterWorktreeRemove(
  worktree: WorktreeSummary,
  branches: Loadable<Branch[]>,
  worktrees: Loadable<WorktreeSummary[]>,
): string | null {
  if (worktree.branch === null || branches.state !== 'ready') return null;
  const local = branches.value.find(
    (branch) => !branch.remote && branch.name === worktree.branch,
  );
  return local !== undefined && deletable(local, worktrees, worktree.path)
    ? local.name
    : null;
}
