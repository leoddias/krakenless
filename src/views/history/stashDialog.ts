/**
 * The question stashing the working tree asks.
 *
 * Its own module for the same reason `mergeDialog` is: the sentence the user
 * agrees to *is* the confirmation reason the git layer records (see
 * `git/confirm.ts`), so it has one home rather than being retyped wherever the
 * action is offered.
 */

import type { Operation } from '../../git/operation';
import { stashAll } from '../../state/actions';
import type { Store } from '../../state/store';
import type { ConfirmDialog } from './CommitActions';
import { isClean, tallySentence, type WorkingTreeTally } from './workingTreeTally';

/**
 * Why the working tree cannot be stashed right now, or `null` when it can.
 *
 * Pure and exported because every one of these is a way to lose work, and a
 * rule that decides whether a destructive command is reachable belongs
 * somewhere it can be asserted directly.
 *
 * **Mid-operation is the one that matters.** During a merge, cherry-pick,
 * rebase or revert, git keeps the operation's state in the repository —
 * `MERGE_HEAD`, `CHERRY_PICK_HEAD`, the rebase directory — and `git stash`
 * takes it with the working tree. Git refuses while paths are still unmerged,
 * which sounds like protection, but this app's own conflict resolver *stages*
 * resolutions: the moment the last conflict is resolved the tree is no longer
 * unmerged, the stash succeeds, and the operation's state is gone. Measured
 * against git 2.39: a merge loses `MERGE_HEAD` and can no longer be aborted or
 * committed as a merge; a cherry-pick can no longer be continued; and a rebase
 * — the worst of the three — reports "Successfully rebased and updated
 * refs/heads/<branch>" while the replayed commit is *gone from the branch*,
 * surviving only in the stash entry and the reflog. Nothing on screen says so.
 *
 * The tracked count is the second rule: see `tallyTracked` for why the row's
 * own counts cannot answer this question.
 */
export function stashRefusalReason(
  operation: Operation,
  busy: boolean,
  tracked: WorkingTreeTally,
): string | null {
  if (busy) return 'A git command is already running.';
  if (operation.kind !== null) {
    return `A ${operation.kind} is in progress. Stashing now would take its state with the working tree, and the commit being replayed would be lost.`;
  }
  if (isClean(tracked)) {
    return 'There are no tracked changes to stash. Untracked files are left where they are.';
  }
  return null;
}

/**
 * What the user is told will happen.
 *
 * It names the counts, because "stash your changes" and "stash 412 changes"
 * deserve different amounts of thought, and it says where the work goes —
 * a stash is only reassuring to somebody who knows the list exists.
 */
export function stashQuestion(tally: WorkingTreeTally): string {
  return `Move ${tallySentence(tally)} off the working tree and into a new stash entry.`;
}

export function stashDialog(store: Store, tally: WorkingTreeTally): ConfirmDialog {
  return {
    kind: 'confirm',
    title: 'Stash tracked changes?',
    question: stashQuestion(tally),
    // Untracked files staying put is the single most surprising thing about
    // this, so it is said before the click rather than discovered after it.
    detail:
      'Tracked changes only: untracked files stay where they are. The entry appears in the stash list, and "Pop" brings the changes back — as unstaged edits, since a pop does not restore what was staged.',
    confirmLabel: 'Stash',
    // Not danger: nothing is destroyed. The work moves somewhere the app shows
    // and can restore, which is the recoverable form the safety bar asks for.
    danger: false,
    run: (reason) => stashAll(store, {}, reason),
  };
}
