/**
 * The question a merge asks, wherever it was started from.
 *
 * Its own module because both ways to start a merge need it — the commit menu
 * and the drag of a branch chip onto the checkout — and neither should have to
 * import the other's component file to ask the same question. One sentence,
 * one confirmation reason, one place to change either of them.
 */

import { mergeRefInto } from '../../state/actions';
import type { Store } from '../../state/store';
import type { ConfirmDialog } from './CommitActions';
import { mergeQuestion } from './commitMenu';

export function mergeDialog(
  store: Store,
  branch: string,
  ref: string,
  label: string,
): ConfirmDialog {
  return {
    kind: 'confirm',
    title: `Merge ${label} into ${branch}?`,
    question: mergeQuestion(label, branch),
    confirmLabel: 'Merge',
    // Not danger: a merge adds commits and rewrites none. What it can do is
    // stop on a conflict, which the notice afterwards explains.
    danger: false,
    run: (reason) => mergeRefInto(store, branch, ref, label, reason),
  };
}
