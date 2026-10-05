/**
 * Editing the message of the commit HEAD is on.
 *
 * A double click on that row's message opens it for editing — the quick fix
 * for a typo in the commit just made. Only HEAD: any other commit would need a
 * rebase to reword, which replays every commit after it, and that is a
 * different operation with different ways to go wrong.
 *
 * The rules are pure and live here so the one that decides whether a rewrite
 * is reachable can be asserted directly, the same way `stashDialog` does it.
 */

import type { Operation } from '../../git/operation';
import type { Branch, Commit } from '../../git/types';
import { rewordHeadCommit } from '../../state/actions';
import type { Store } from '../../state/store';
import type { MessageDialog } from './CommitActions';
import { checkedOutBranch } from './headRef';

/**
 * Why the HEAD message cannot be edited right now, or `null` when it can.
 *
 * Mid-operation is the one that matters: during a rebase HEAD is a commit
 * being replayed, and amending it there rewrites a step of the rebase rather
 * than the commit the user sees at the tip of their branch. Same for a merge,
 * where the next commit is the merge itself.
 */
export function rewordRefusal(
  operation: Operation,
  busy: boolean,
  hasConflicts: boolean,
): string | null {
  if (busy) return 'A git command is already running.';
  if (operation.kind !== null) {
    return `A ${operation.kind} is in progress. Finish or abort it before editing a commit message.`;
  }
  if (hasConflicts) {
    return 'The repository has conflicts. Resolve them before editing a commit message.';
  }
  return null;
}

/**
 * Whether the commit has visibly left this machine.
 *
 * Two signs, either one enough: a remote-tracking branch sits on the commit
 * itself, or the checked-out branch has an upstream and is not ahead of it —
 * so its tip, this commit, is already part of the upstream. Neither is proof
 * that nobody else has it (a push to a branch this clone does not track would
 * not show), which is why the dialog says "do not" rather than refusing.
 */
export function looksPublished(commit: Commit, branches: Branch[] | null): boolean {
  if (commit.refs.some((ref) => ref.kind === 'remote-branch')) return true;
  const current = checkedOutBranch(commit.refs);
  if (current === null || branches === null) return false;
  const branch = branches.find((one) => !one.remote && one.name === current);
  return branch?.upstream !== undefined && branch.ahead === 0;
}

/** The sentence the user agrees to, and the confirmation reason it becomes. */
export function rewordQuestion(commit: Commit): string {
  const branch = checkedOutBranch(commit.refs);
  const where = branch === null ? 'the detached HEAD' : branch;
  return `Rewrite the message of ${commit.shortOid}, the last commit on ${where}. It gets a new hash; the old commit stays in the reflog.`;
}

export function rewordDialog(
  store: Store,
  commit: Commit,
  message: string,
  branches: Branch[] | null,
): MessageDialog {
  const published = looksPublished(commit, branches);
  return {
    kind: 'message',
    title: 'Edit commit message',
    question: rewordQuestion(commit),
    ...(published
      ? {
          warning:
            'This commit is already on a remote. Rewriting it means a force push, and anyone who fetched it will have to reconcile. Do not rewrite a commit others may have built on.',
        }
      : {}),
    initial: message,
    confirmLabel: 'Save message',
    run: (next, reason) =>
      rewordHeadCommit(store, commit.oid, checkedOutBranch(commit.refs), next, reason),
  };
}
