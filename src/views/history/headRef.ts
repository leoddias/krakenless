/**
 * "You are here" on a history row.
 *
 * `git log --decorate=full` writes the checked-out branch as a single token,
 * `HEAD -> refs/heads/main`, and the parser turns it into two refs in that
 * order (see `parsers/log.ts`). The branch HEAD points at is therefore the one
 * right after the HEAD marker — a branch that merely happens to sit on the
 * same commit arrives later in the list and is not the checkout.
 */

import type { CommitRef } from '../../git/types';

/** The branch HEAD points at on this row, or `null` — no HEAD, or detached. */
export function checkedOutBranch(refs: CommitRef[]): string | null {
  const head = refs.findIndex((ref) => ref.kind === 'head');
  if (head === -1) return null;
  const next = refs[head + 1];
  return next !== undefined && next.kind === 'branch' ? next.name : null;
}

/** Whether this row is the commit HEAD resolves to, branch or detached. */
export function isHeadRow(refs: CommitRef[]): boolean {
  return refs.some((ref) => ref.kind === 'head');
}

/**
 * Whether a chip is the one that says where the user is standing: the branch
 * HEAD points at, or the bare HEAD marker when the checkout is detached.
 */
export function isCurrentChip(ref: CommitRef, current: string | null): boolean {
  if (ref.kind === 'head') return current === null;
  return ref.kind === 'branch' && ref.name === current;
}

/**
 * Whether a chip should be dropped as a duplicate. With a branch checked out
 * the HEAD chip says nothing the ✓ on that branch's chip does not, and two
 * chips for one fact cost the width the branch names need.
 */
export function isRedundantHeadChip(ref: CommitRef, current: string | null): boolean {
  return ref.kind === 'head' && current !== null;
}
