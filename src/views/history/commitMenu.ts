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
import type { Commit, CommitRef, Remote, StashEntry } from '../../git/types';
import type { Loadable } from '../../state/store';

/** What a menu item does when it is chosen. */
export type CommitAction =
  | { kind: 'checkout' }
  | { kind: 'branch' }
  | { kind: 'tag'; annotated: boolean }
  | { kind: 'cherry-pick' }
  | { kind: 'revert' }
  | { kind: 'merge'; branch: string; ref: string; label: string }
  | { kind: 'push-tag'; remote: string; tag: string }
  | {
      kind: 'rebase';
      branch: string;
      /** True when the replay will have to stash uncommitted work first. */
      autostash: boolean;
    }
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
   * dirty work tree; see {@link hasTrackedChanges}. It no longer blocks
   * anything: the rebase stashes them itself. It decides whether the question
   * mentions that stash, so `false` while the status is unread costs the user
   * only a sentence they did not need.
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

/**
 * What this row offers to merge, in the order it is offered.
 *
 * A row is a commit, and a commit can carry several names. Each branch on it is
 * a separate thing to merge and gets its own item, because "merge this row" is
 * not a sentence git can act on — `git merge feature/x` and
 * `git merge origin/feature/x` are different merges the moment those two refs
 * disagree, which is exactly when somebody reaches for this.
 *
 * The checked-out branch is left out: merging a branch into itself is the one
 * merge that can never mean anything. A row with no branch at all is still
 * mergeable by sha, which is what {@link buildCommitMenu} falls back to.
 */
export function mergeableRefs(commit: Commit, branch: string | null): CommitRef[] {
  return commit.refs.filter(
    (ref) =>
      (ref.kind === 'branch' || ref.kind === 'remote-branch') && ref.name !== branch,
  );
}

/**
 * The sentence the user agrees to before a merge runs, and the reason string
 * the git layer records. Shared with the drag-and-drop path in `HistoryView`,
 * so the two ways to start a merge cannot describe it differently.
 */
export function mergeQuestion(label: string, branch: string): string {
  return `Merge ${label} into ${branch}. Commits from ${label} that ${branch} does not have are added to it; if the two have both moved on, git writes a merge commit. Nothing on ${label} changes, and no commit is rewritten.`;
}

/** The merge items for a row: one per branch on it, or the commit itself. */
function mergeItems(context: CommitMenuContext): CommitMenuItem[] {
  const block = branchBlock(context, 'merge into');
  const branch = typeof context.branch === 'string' ? context.branch : null;
  const refs = mergeableRefs(context.commit, branch);
  const target = branch ?? 'this branch';

  if (refs.length === 0) {
    // Nothing named on this row, so the sha is the only handle there is. On the
    // row HEAD sits on there is nothing to merge either way, and saying so
    // beats an item that would answer "Already up to date".
    const here = isOnHeadRow(context.commit)
      ? `${target} is already here, so there is nothing to merge.`
      : null;
    return [
      {
        id: 'merge',
        label: `Merge this commit into ${target}`,
        disabled: block ?? here,
        ...(branch === null
          ? {}
          : {
              action: {
                kind: 'merge' as const,
                branch,
                ref: context.commit.oid,
                label: commitLabel(context.commit),
              },
            }),
      },
    ];
  }

  return refs.map((ref) => ({
    id: `merge-${ref.kind}-${ref.name}`,
    label: `Merge ${ref.name} into ${target}`,
    disabled: block,
    ...(branch === null
      ? {}
      : {
          action: {
            kind: 'merge' as const,
            branch,
            ref: ref.name,
            label: ref.name,
          },
        }),
  }));
}

/** True when this row is where HEAD is, ref or not. */
function isOnHeadRow(commit: Commit): boolean {
  return commit.refs.some((ref) => ref.kind === 'head');
}

/**
 * The tags on this row, each offered to the remote it would go to.
 *
 * `git push` does not carry tags with it, so a tag made here exists nowhere
 * else until somebody pushes it by name — which is how a release tag ends up
 * living on one laptop. Every tag on the row gets an item; whether the remote
 * already has it is not something the app knows without asking, and offering
 * the push is cheaper than pretending to know. Git refuses a tag that is
 * already there and unchanged with "Everything up-to-date".
 */
function pushTagItems(context: CommitMenuContext): CommitMenuItem[] {
  const tags = context.commit.refs.filter((ref) => ref.kind === 'tag');
  if (tags.length === 0) return [];

  const link = linkTarget(context);
  const shared = blocked(context);
  const reason =
    shared ?? (link.kind === 'none' ? `Nowhere to push to. ${link.reason}` : null);
  const remote = link.kind === 'remote' ? link.remote : null;

  return tags.map((tag) => ({
    id: `push-tag-${tag.name}`,
    label: remote === null ? `Push tag ${tag.name}` : `Push tag ${tag.name} to ${remote}`,
    disabled: reason,
    ...(remote === null || reason !== null
      ? {}
      : { action: { kind: 'push-tag' as const, remote, tag: tag.name } }),
  }));
}

/** The whole menu for one commit, grouped into the sections it is drawn in. */
export function buildCommitMenu(context: CommitMenuContext): CommitMenuSection[] {
  const shared = blocked(context);
  // A dirty working tree is no longer a refusal: the rebase carries
  // `--autostash`, so git puts the changes aside and brings them back itself.
  // The question says so before it runs.
  const rebaseBlock = branchBlock(context, 'rebase');
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
      ...pushTagItems(context),
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
      ...mergeItems(context),
      {
        id: 'rebase',
        label: `Rebase ${branch ?? 'this branch'} onto this commit`,
        disabled: rebaseBlock,
        ...(branch === null
          ? {}
          : {
              action: {
                kind: 'rebase' as const,
                branch,
                autostash: context.hasLocalChanges,
              },
            }),
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

/**
 * The rebase question, including what happens to uncommitted work.
 *
 * The autostash sentence appears only when there is something to stash. Saying
 * it on a clean tree would describe a stash that is never created, and the
 * reason string is also the confirmation the git layer records — it has to be
 * true of the command that actually runs.
 */
export function rebaseQuestion(
  branch: string,
  commit: Commit,
  options: { autostash: boolean } = { autostash: false },
): string {
  const rewrite = `Replay ${branch} onto ${commitLabel(commit)}. Every commit on ${branch} that is not already there is rewritten with a new id, so anyone who has pulled this branch will have to reconcile it.`;
  if (!options.autostash) return rewrite;
  return `${rewrite} Your uncommitted changes are stashed before the replay and brought back after it; if they do not come back cleanly they stay in a stash, and Krakenless says so.`;
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
