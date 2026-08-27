/**
 * The model behind the commit context menu, and the words its questions use.
 *
 * The menu is built as data rather than JSX for the same reason the remote
 * toolbar derives its gates as functions: every item is an offer to run a git
 * command, and half of them must not be offered at all in some states — HEAD
 * detached, a merge in progress, another command already running. Deriving
 * that here makes each refusal a test rather than a rendering detail.
 *
 * Nothing is ever hidden for being unavailable. A missing item reads as a
 * feature this app does not have; a greyed one with a reason next to it reads
 * as "not right now, and here is why".
 */

import type { ResetMode } from '../../git/commits';
import { commitWebUrl } from '../../git/remoteWeb';
import type { Commit, Remote, StashEntry } from '../../git/types';
import type { Loadable } from '../../state/store';

/** What a menu item does when it is chosen. */
export type CommitAction =
  | { kind: 'checkout' }
  | { kind: 'branch' }
  | { kind: 'tag'; annotated: boolean }
  | { kind: 'cherry-pick' }
  | { kind: 'revert' }
  | { kind: 'rebase'; branch: string }
  | { kind: 'reset'; branch: string; mode: ResetMode }
  | { kind: 'copy'; text: string; what: string }
  /** Only ever produced by {@link buildStashMenu}. */
  | { kind: 'stash'; entry: StashEntry; op: 'apply' | 'pop' | 'drop' };

export interface CommitMenuItem {
  id: string;
  label: string;
  /** Why this cannot run right now, or `null` when it can. */
  disabled: string | null;
  action?: CommitAction;
  submenu?: CommitMenuItem[];
}

/** Items are grouped; the renderer draws a rule between groups. */
export type CommitMenuSection = CommitMenuItem[];

/** Everything the menu needs to decide what it may offer. */
export interface CommitMenuContext {
  commit: Commit;
  /**
   * Branch HEAD is on: a name, `null` for a detached HEAD, and `undefined`
   * when the status has not been read. Those are three different answers and
   * the menu says something different for each — "not on a branch" and "not
   * known yet" send the user to fix different things.
   */
  branch: string | null | undefined;
  busy: boolean;
  hasConflicts: boolean;
  /**
   * Tracked files changed in the index or the working tree — what git calls a
   * dirty work tree. Only the operations git refuses over one consult it; see
   * {@link hasTrackedChanges}. `false` while the status is unread, which costs
   * nothing: every such item is already disabled for an unknown branch.
   */
  hasLocalChanges: boolean;
  remotes: Loadable<Remote[]>;
}

const BUSY = 'Another git operation is already running.';
const CONFLICTS = 'A merge is in progress with unresolved conflicts. Resolve them first.';

/** The reason no git command may run at all, or `null`. */
function blocked(context: CommitMenuContext): string | null {
  if (context.busy) return BUSY;
  if (context.hasConflicts) return CONFLICTS;
  return null;
}

/**
 * Why an operation that moves the current branch cannot run, or `null`.
 *
 * Both callers name the branch in their label, so neither may be offered
 * without one — an item reading "Reset  to this commit" is worse than a
 * disabled one that explains itself.
 */
function branchBlock(context: CommitMenuContext, verb: string): string | null {
  const shared = blocked(context);
  if (shared !== null) return shared;
  if (context.branch === undefined) {
    return `The branch has not been read yet, so Krakenless does not know what it would ${verb}.`;
  }
  if (context.branch === null) {
    return `HEAD is detached: you are not on a branch, so there is nothing to ${verb}.`;
  }
  return null;
}

/**
 * Why an operation that replays commits over the working tree cannot run.
 *
 * git refuses these outright with "cannot rebase: You have unstaged changes",
 * and the app used to relay that as an error notice *after* the user had
 * confirmed a rewrite of their branch. Answering before the question is asked
 * is the same refusal, minus the false start.
 */
function dirtyBlock(context: CommitMenuContext, verb: string): string | null {
  if (!context.hasLocalChanges) return null;
  return `The working tree has uncommitted changes, and git will not ${verb} over them. Commit or stash them first.`;
}

/**
 * The remote whose web page a link would point at, and the link itself.
 *
 * The first remote wins, with `origin` sorted first by the caller — a
 * repository with several remotes usually has one that is "the" one, and
 * asking which before copying a link is a dialog nobody wants.
 */
type LinkTarget =
  | { kind: 'remote'; remote: string; url: string | null }
  /**
   * Why there is no remote to link to. "None exists" and "the list could not be
   * read" are different problems with different fixes, and a menu that reported
   * the second as the first would send the user to add a remote they have.
   */
  | { kind: 'none'; reason: string };

function linkTarget(context: CommitMenuContext): LinkTarget {
  switch (context.remotes.state) {
    case 'idle':
    case 'loading':
      return { kind: 'none', reason: 'The list of remotes has not been read yet.' };
    case 'error':
      return {
        kind: 'none',
        reason: `The list of remotes could not be read: ${context.remotes.message}`,
      };
    case 'ready':
      break;
  }
  const sorted = [...context.remotes.value].sort(
    (a, b) => Number(b.name === 'origin') - Number(a.name === 'origin'),
  );
  const first = sorted[0];
  if (first === undefined) {
    return { kind: 'none', reason: 'This repository has no remote to link to.' };
  }
  return {
    kind: 'remote',
    remote: first.name,
    url: commitWebUrl(first.fetchUrl, context.commit.oid),
  };
}

const RESET_MODES: { mode: ResetMode; label: string }[] = [
  { mode: 'soft', label: 'Soft — keep the changes staged' },
  { mode: 'mixed', label: 'Mixed — keep the changes, unstaged' },
  { mode: 'hard', label: 'Hard — discard the changes' },
];

/** The whole menu for one commit, grouped into the sections it is drawn in. */
export function buildCommitMenu(context: CommitMenuContext): CommitMenuSection[] {
  const shared = blocked(context);
  const rebaseBlock = branchBlock(context, 'rebase') ?? dirtyBlock(context, 'rebase');
  const resetBlock = branchBlock(context, 'reset');
  const branch = typeof context.branch === 'string' ? context.branch : null;
  const link = linkTarget(context);

  return [
    [
      {
        id: 'checkout',
        label: 'Checkout this commit',
        disabled: shared,
        action: { kind: 'checkout' },
      },
    ],
    [
      {
        id: 'branch',
        label: 'Create branch here',
        disabled: shared,
        action: { kind: 'branch' },
      },
      {
        id: 'tag',
        label: 'Create tag here',
        disabled: shared,
        action: { kind: 'tag', annotated: false },
      },
      {
        id: 'annotated-tag',
        label: 'Create annotated tag here',
        disabled: shared,
        action: { kind: 'tag', annotated: true },
      },
    ],
    [
      {
        id: 'cherry-pick',
        label: 'Cherry pick commit',
        disabled: shared,
        action: { kind: 'cherry-pick' },
      },
      {
        id: 'revert',
        label: 'Revert commit',
        disabled: shared,
        action: { kind: 'revert' },
      },
      {
        id: 'rebase',
        label: `Rebase ${branch ?? 'this branch'} onto this commit`,
        disabled: rebaseBlock,
        ...(branch === null ? {} : { action: { kind: 'rebase' as const, branch } }),
      },
      {
        id: 'reset',
        label: `Reset ${branch ?? 'this branch'} to this commit`,
        disabled: resetBlock,
        submenu: RESET_MODES.map(({ mode, label }) => ({
          id: `reset-${mode}`,
          label,
          disabled: resetBlock,
          ...(branch === null
            ? {}
            : { action: { kind: 'reset' as const, branch, mode } }),
        })),
      },
    ],
    [
      {
        id: 'copy-sha',
        label: 'Copy commit sha',
        disabled: null,
        action: {
          kind: 'copy',
          text: context.commit.oid,
          what: 'The commit sha',
        },
      },
      copyLinkItem(link),
    ],
  ];
}

function copyLinkItem(link: LinkTarget): CommitMenuItem {
  if (link.kind === 'none') {
    return {
      id: 'copy-link',
      label: 'Copy link to this commit on remote',
      disabled: link.reason,
    };
  }
  if (link.url === null) {
    return {
      id: 'copy-link',
      label: `Copy link to this commit on remote: ${link.remote}`,
      disabled: `Krakenless cannot derive a web address for "${link.remote}".`,
    };
  }
  return {
    id: 'copy-link',
    label: `Copy link to this commit on remote: ${link.remote}`,
    disabled: null,
    action: { kind: 'copy', text: link.url, what: 'The link' },
  };
}

// --- the words the questions use -------------------------------------------

/** How a commit is named in a question: short oid plus what it says. */
export function commitLabel(commit: Commit): string {
  const subject = commit.subject === '' ? '(no subject)' : commit.subject;
  return `${commit.shortOid} — ${subject}`;
}

/**
 * The reset question, in the words the user answers.
 *
 * The consequence is spelled out per mode rather than shared, because the three
 * differ in exactly the way that matters: only `hard` takes work off disk, and
 * a question that did not say so would be the same question for all three.
 */
export function resetQuestion(branch: string, mode: ResetMode, commit: Commit): string {
  const head = `Move ${branch} to ${commitLabel(commit)}.`;
  switch (mode) {
    case 'soft':
      return `${head} Commits after it stop being on ${branch}; their changes stay staged.`;
    case 'mixed':
      return `${head} Commits after it stop being on ${branch}; their changes stay in the working tree, unstaged.`;
    case 'hard':
      return `${head} Commits after it stop being on ${branch}, and every uncommitted change in the working tree is destroyed. This cannot be undone from Krakenless.`;
  }
}

export function rebaseQuestion(branch: string, commit: Commit): string {
  return `Replay ${branch} onto ${commitLabel(commit)}. Every commit on ${branch} that is not already there is rewritten with a new id, so anyone who has pulled this branch will have to reconcile it.`;
}

// --- the stash menu ---------------------------------------------------------

/**
 * What a stash row offers.
 *
 * A different menu, not the commit one with items removed: almost nothing on
 * the commit menu means anything here. Cherry-picking a stash replays a merge
 * of your own index onto itself; resetting a branch *to* a stash puts the
 * bookkeeping commit on the branch. Offering those greyed out would suggest
 * they are things you might one day do to a stash. They are not.
 *
 * `Edit stash message` and `Share as Cloud Patch` from GitKraken's menu are
 * deliberately absent: the first needs the stash ref rewritten, and the second
 * needs an account and a server.
 */
export function buildStashMenu(
  entry: StashEntry,
  context: { busy: boolean; hasConflicts: boolean },
): CommitMenuSection[] {
  const shared = context.busy
    ? BUSY
    : context.hasConflicts
      ? 'A merge is in progress with unresolved conflicts. Resolve them before touching a stash.'
      : null;

  return [
    [
      {
        id: 'stash-apply',
        label: 'Apply Stash',
        disabled: shared,
        action: { kind: 'stash', entry, op: 'apply' },
      },
      {
        id: 'stash-pop',
        label: 'Pop Stash',
        disabled: shared,
        action: { kind: 'stash', entry, op: 'pop' },
      },
      {
        id: 'stash-drop',
        label: 'Delete Stash',
        disabled: shared,
        action: { kind: 'stash', entry, op: 'drop' },
      },
    ],
    [
      {
        id: 'copy-sha',
        label: 'Copy stash commit sha',
        disabled: null,
        action: { kind: 'copy', text: entry.oid, what: 'The stash commit sha' },
      },
    ],
  ];
}
