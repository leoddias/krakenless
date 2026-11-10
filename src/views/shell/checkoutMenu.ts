/**
 * What the toolbar's branch picker offers, as data.
 *
 * Pure and on its own, because the rules here are the whole feature: which
 * branch is taken from another worktree, which cannot be and why, which worktree is the one you are
 * standing in, and what each entry claims will happen when it is chosen. The
 * component next door only draws them.
 */

import type { Branch, RepoStatus } from '../../git/types';
import type { WorktreeSummary } from '../../git/worktrees';
import type { Loadable } from '../../state/store';

export interface CheckoutChoice {
  id: string;
  label: string;
  disabled: string | null;
  /** What picking it does; absent when it cannot be picked. */
  choose?: () => void;
}

/**
 * The items the picker offers, as data.
 *
 * Pure and exported because the rules here are the whole feature: which branch
 * cannot be checked out and why, which worktree is the one you are standing in,
 * and what each entry claims will happen when it is chosen.
 */
export function buildCheckoutMenu(options: {
  branches: Loadable<Branch[]>;
  worktrees: Loadable<WorktreeSummary[]>;
  busy: boolean;
  onCheckout: (branch: string) => void;
  onOpen: (path: string) => void;
}): { branches: CheckoutChoice[]; worktrees: CheckoutChoice[] } {
  const { branches, worktrees, busy, onCheckout, onOpen } = options;

  // Which branch is open in which worktree. `git worktree list` is the
  // authority. The one this window stands in holds the current branch, which
  // `branch.current` already answers, so every other entry is a worktree a
  // checkout here would take the branch from (ADR-0068).
  const heldBy = new Map<string, WorktreeSummary>();
  if (worktrees.state === 'ready') {
    for (const worktree of worktrees.value) {
      if (worktree.branch === null) continue;
      heldBy.set(worktree.branch, worktree);
    }
  }

  const branchChoices: CheckoutChoice[] =
    branches.state === 'ready'
      ? branches.value
          .filter((branch) => !branch.remote)
          .map((branch) => {
            const holder = branch.current ? undefined : heldBy.get(branch.name);
            const blocked = busy
              ? 'A git command is already running.'
              : branch.current
                ? null
                : holderRefusal(branch.name, holder);
            // Said on the item, because choosing it changes that worktree:
            // it is left detached at the commit it had.
            const label = branch.current
              ? `${branch.name} (current)`
              : holder === undefined
                ? branch.name
                : `${branch.name} — take from ${holder.path}`;
            return {
              id: `branch:${branch.name}`,
              label,
              disabled: branch.current ? null : blocked,
              ...(blocked !== null || branch.current
                ? {}
                : { choose: () => onCheckout(branch.name) }),
            };
          })
      : [];

  const worktreeChoices: CheckoutChoice[] =
    worktrees.state === 'ready'
      ? worktrees.value
          .filter((worktree) => !worktree.main && !worktree.bare)
          .map((worktree) => ({
            id: `worktree:${worktree.path}`,
            label: `${worktree.path}${worktree.branch === null ? ' — detached' : ` — ${worktree.branch}`}`,
            // A worktree whose directory is gone opens onto nothing. Git says
            // so in `prunable`, and that is a better message than the app's.
            disabled:
              worktree.prunable === null
                ? null
                : `This worktree cannot be opened: ${worktree.prunable}`,
            ...(worktree.prunable === null
              ? { choose: () => onOpen(worktree.path) }
              : {}),
          }))
      : [];

  return { branches: branchChoices, worktrees: worktreeChoices };
}

/**
 * Why a branch another worktree holds cannot be taken from it, or `null` when
 * it can. The same three refusals `switchTakingBranch` makes, said before the
 * click: a lock, a directory that is gone. (An operation in progress there is
 * only known by asking git, so that one arrives as the switch's error.)
 */
function holderRefusal(name: string, holder: WorktreeSummary | undefined): string | null {
  if (holder === undefined) return null;
  if (holder.locked !== null) {
    return `"${name}" is checked out in ${holder.path}, which is locked${holder.locked === '' ? '' : ` (${holder.locked})`}.`;
  }
  if (holder.prunable !== null) {
    return `"${name}" is checked out in ${holder.path}, which git cannot reach: ${holder.prunable}`;
  }
  return null;
}

/**
 * What the button says, in the words the status supports.
 *
 * Four answers, not two: "not on a branch" and "not read yet" and "could not be
 * read" are different facts, and each sends the user somewhere different.
 * `muted` is for the three that are not a branch name.
 */
export function checkoutLabel(status: Loadable<RepoStatus>): {
  text: string;
  muted: boolean;
} {
  switch (status.state) {
    case 'ready':
      return status.value.detached
        ? { text: 'detached HEAD', muted: true }
        : { text: status.value.branch ?? '—', muted: status.value.branch === null };
    case 'loading':
      return { text: 'reading status…', muted: true };
    case 'error':
      return { text: 'status unavailable', muted: true };
    case 'idle':
      return { text: '—', muted: true };
  }
}
