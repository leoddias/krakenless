/**
 * Pure helpers behind the remote toolbar.
 *
 * They exist as functions rather than inline JSX for one reason: every claim
 * this panel makes about the repository ("2 ahead", "no upstream", "you are
 * not on a branch") is a claim a user acts on with a network operation, so
 * each one is derived by something that can be unit tested on its own.
 */

import type { Branch, Remote, RepoStatus } from '../../git/types';
import type { Loadable } from '../../state/store';

/** A remote-tracking ref split into the two halves push needs. */
export interface UpstreamRef {
  remote: string;
  branch: string;
}

/**
 * Splits `origin/feature/x` into `origin` + `feature/x`.
 *
 * Git reports an upstream as one string and gives no delimiter, so the first
 * slash is the only split available. It is right for every remote whose name
 * has no slash in it, which is every remote git itself creates. Anything that
 * does not have a non-empty name on both sides is reported as unparsable
 * rather than guessed at — pushing to a remote we misread is exactly the
 * mistake this panel must not make.
 */
export function parseUpstream(ref: string): UpstreamRef | null {
  const slash = ref.indexOf('/');
  if (slash <= 0) return null;
  const remote = ref.slice(0, slash);
  const branch = ref.slice(slash + 1);
  if (branch.length === 0) return null;
  return { remote, branch };
}

/** What the current HEAD is, as far as the toolbar is allowed to claim. */
export type UpstreamState =
  /** The status has not been read (or could not be), so nothing is known. */
  | { kind: 'unknown' }
  /** HEAD is not on a branch. */
  | { kind: 'detached' }
  /** On a branch that has no commit yet (fresh repository). */
  | { kind: 'unborn'; branch: string }
  | { kind: 'no-upstream'; branch: string }
  | {
      kind: 'tracking';
      branch: string;
      upstream: UpstreamRef;
      /** Undefined when git did not report the counts; never invented as 0. */
      ahead?: number;
      behind?: number;
    }
  /** Tracks something we could not split into remote + branch. */
  | { kind: 'unreadable-upstream'; branch: string; upstream: string };

export function readUpstream(status: Loadable<RepoStatus>): UpstreamState {
  if (status.state !== 'ready') return { kind: 'unknown' };
  const value = status.value;
  if (value.detached) return { kind: 'detached' };
  if (value.branch === null) return { kind: 'unknown' };
  if (value.head === null) return { kind: 'unborn', branch: value.branch };
  if (value.upstream === undefined) return { kind: 'no-upstream', branch: value.branch };

  const upstream = parseUpstream(value.upstream);
  if (upstream === null) {
    return {
      kind: 'unreadable-upstream',
      branch: value.branch,
      upstream: value.upstream,
    };
  }
  return {
    kind: 'tracking',
    branch: value.branch,
    upstream,
    ...(value.ahead === undefined ? {} : { ahead: value.ahead }),
    ...(value.behind === undefined ? {} : { behind: value.behind }),
  };
}

/** One headline plus one explanatory line, for every state of the status read. */
export interface Summary {
  headline: string;
  detail: string;
}

/**
 * Describes the branch/upstream relationship.
 *
 * Ahead/behind numbers appear only in the `ready` + `tracking` case. A stale or
 * failed status read gets words, never digits: a "0 behind" invented from a
 * read that never returned is an invitation to push over someone's work.
 */
export function summarize(status: Loadable<RepoStatus>): Summary {
  if (status.state === 'idle') {
    return {
      headline: 'No repository open',
      detail: 'Open a repository to fetch, pull or push.',
    };
  }
  if (status.state === 'loading') {
    return {
      headline: 'Reading branch status…',
      detail: 'Ahead and behind counts appear once git answers.',
    };
  }
  if (status.state === 'error') {
    return {
      headline: 'Branch status unavailable',
      detail: `${status.message}${status.kind === undefined ? '' : ` (${status.kind})`}`,
    };
  }

  const upstream = readUpstream(status);
  switch (upstream.kind) {
    case 'unknown':
      return {
        headline: 'Branch unknown',
        detail: 'Git did not report a branch for this repository.',
      };
    case 'detached':
      return {
        headline: 'Detached HEAD',
        detail: 'You are not on a branch, so there is no upstream to compare against.',
      };
    case 'unborn':
      return {
        headline: `${upstream.branch} — no commits yet`,
        detail: 'Make the first commit before publishing this branch.',
      };
    case 'no-upstream':
      return {
        headline: `${upstream.branch} — no upstream`,
        detail:
          'This branch is not tracking anything yet. Publish it to push it to a remote and start tracking it.',
      };
    case 'unreadable-upstream':
      return {
        headline: `${upstream.branch} — upstream not understood`,
        detail: `Git reports the upstream as "${upstream.upstream}", which Krakenless cannot split into a remote and a branch.`,
      };
    case 'tracking':
      return {
        headline: `${upstream.branch} → ${upstream.upstream.remote}/${upstream.upstream.branch}`,
        detail: countsSentence(upstream.ahead, upstream.behind),
      };
  }
}

function countsSentence(ahead: number | undefined, behind: number | undefined): string {
  // Git did not report the counts — `status.aheadBehind=false`, or the
  // remote-tracking ref is gone. Saying "up to date" here would be a guess the
  // user could push on.
  if (ahead === undefined || behind === undefined) {
    return 'Git did not report how this branch compares to its upstream. Fetch to find out.';
  }
  if (ahead === 0 && behind === 0)
    return 'Git reported no commits on either side, as of the last fetch.';
  const parts: string[] = [];
  if (ahead > 0) parts.push(`${ahead} ahead`);
  if (behind > 0) parts.push(`${behind} behind`);
  return `${parts.join(', ')}, as of the last fetch.`;
}

/**
 * Remote names the app can offer as a publish target.
 *
 * `git remote` is the authority: a remote that has never been fetched from has
 * no tracking refs at all, so a list reconstructed from branches would leave it
 * invisible in the picker. The branch list stays as the fallback for the moment
 * before the remotes read lands (or if it fails), because a picker with the
 * obvious name in it beats an empty one.
 *
 * `origin` sorts first because it is the conventional default; the rest are
 * alphabetical so the order does not shift under the cursor between reads.
 */
export function candidateRemotes(
  branches: Loadable<Branch[]>,
  remotes: Loadable<Remote[]> = { state: 'idle' },
): string[] {
  if (remotes.state === 'ready' && remotes.value.length > 0) {
    return sortRemotes(remotes.value.map((remote) => remote.name));
  }
  if (branches.state !== 'ready') return [];
  const names = new Set<string>();
  for (const branch of branches.value) {
    if (branch.remote) {
      const parsed = parseUpstream(branch.name);
      if (parsed !== null) names.add(parsed.remote);
    }
    if (branch.upstream !== undefined) {
      const parsed = parseUpstream(branch.upstream);
      if (parsed !== null) names.add(parsed.remote);
    }
  }
  return sortRemotes([...names]);
}

function sortRemotes(names: string[]): string[] {
  const sorted = [...new Set(names)].sort((a, b) => a.localeCompare(b));
  return sorted.sort((a, b) => Number(b === 'origin') - Number(a === 'origin'));
}

/** Everything the gates need to know, gathered in one place for testability. */
export interface Gate {
  repoOpen: boolean;
  busy: boolean;
  statusState: Loadable<RepoStatus>['state'];
  hasConflicts: boolean;
  upstream: UpstreamState;
  /**
   * Panel state of the branch list, which is where remote names come from.
   * "Not read yet" is not the same as "there are no remotes", and the publish
   * button has to say which of the two it means.
   */
  branchesState: Loadable<Branch[]>['state'];
  /** Remote chosen for publishing a branch that has no upstream, if any. */
  publishRemote: string | null;
}

/**
 * Why an action cannot run right now, or `null` when it can.
 *
 * These strings are rendered next to the disabled button, not hidden in a
 * tooltip: a greyed-out Push with no explanation is indistinguishable from a
 * broken one, and the user's next move is to reach for the command line
 * without knowing what the app objected to.
 */
export function fetchBlock(gate: Gate): string | null {
  if (!gate.repoOpen) return 'No repository is open.';
  if (gate.busy) return 'Another git operation is already running.';
  return null;
}

export function pullBlock(gate: Gate): string | null {
  const shared = sharedBlock(gate);
  if (shared !== null) return shared;

  switch (gate.upstream.kind) {
    case 'unknown':
      return 'Git did not report a branch, so there is nothing to pull into.';
    case 'detached':
      return 'HEAD is detached: you are not on a branch, so there is nothing to pull into.';
    case 'unborn':
      return 'This branch has no commits yet and no upstream to pull from.';
    case 'no-upstream':
      return 'This branch has no upstream. Publish it first, then pull.';
    case 'unreadable-upstream':
      return `Krakenless cannot read the upstream "${gate.upstream.upstream}", so it will not pull on a guess.`;
    case 'tracking':
      return null;
  }
}

/**
 * The counts when the branch and its upstream have both moved, else `null`.
 *
 * Only claimed off numbers git actually reported, and only as of the last
 * fetch — which is exactly the freshness of everything else on this panel.
 * `pull --ff-only` fetches before it refuses, so even counts that were stale
 * when the user clicked Pull are current by the time its refusal re-renders
 * this as the merge-pull.
 */
export function divergence(
  upstream: UpstreamState,
): { ahead: number; behind: number } | null {
  if (upstream.kind !== 'tracking') return null;
  const { ahead, behind } = upstream;
  if (ahead === undefined || behind === undefined) return null;
  return ahead > 0 && behind > 0 ? { ahead, behind } : null;
}

export function pushBlock(gate: Gate): string | null {
  const shared = sharedBlock(gate);
  if (shared !== null) return shared;

  switch (gate.upstream.kind) {
    case 'unknown':
      return 'Git did not report a branch, so there is nothing to push.';
    case 'detached':
      return 'HEAD is detached: you are not on a branch, so there is nothing to push.';
    case 'unborn':
      return 'This branch has no commits yet, so there is nothing to push.';
    case 'unreadable-upstream':
      return `Krakenless cannot read the upstream "${gate.upstream.upstream}", so it will not choose a remote on a guess.`;
    case 'no-upstream':
      return publishBlock(gate);
    case 'tracking': {
      // The push builder always writes `refs/heads/<name>:refs/heads/<name>`,
      // so a branch tracking a differently-named upstream would be pushed to a
      // *different* branch than the one whose counts are on screen. Refuse
      // rather than publish commits somewhere the user was not shown.
      if (gate.upstream.upstream.branch !== gate.upstream.branch) {
        return `This branch tracks ${gate.upstream.upstream.remote}/${gate.upstream.upstream.branch}, which has a different name. Krakenless only pushes a branch to its own name, so push this one from the command line: git push ${gate.upstream.upstream.remote} ${gate.upstream.branch}:${gate.upstream.upstream.branch}`;
      }
      // A branch that is behind cannot be pushed — git refuses a non-fast-
      // forward update — so offering the button only manufactures the
      // rejection. The counts are as fresh as the last fetch; if the remote
      // rewound since, the block errs on the side of not pushing, which is
      // the only safe side. Never `ahead === 0` alone: undefined counts mean
      // "not known", and an unknown push is git's to refuse, not ours.
      const behind = gate.upstream.behind ?? 0;
      if (behind > 0) {
        const commits = behind === 1 ? 'one commit' : `${behind} commits`;
        return `The upstream has ${commits} this branch does not, so git would refuse this push. Pull first, then push.`;
      }
      return null;
    }
  }
}

/**
 * Whether a branch with no upstream can be published right now.
 *
 * The branch list is the only source of remote names, so an unread or failed
 * one means "Krakenless does not know", not "there is no remote". Telling a
 * user to add a remote they already have sends them to fix the wrong thing.
 */
function publishBlock(gate: Gate): string | null {
  if (gate.branchesState === 'idle' || gate.branchesState === 'loading') {
    return 'Reading the list of remotes — the publish target is not known yet.';
  }
  if (gate.branchesState === 'error') {
    return 'The branch list could not be read, so Krakenless does not know which remotes exist.';
  }
  if (gate.publishRemote === null) {
    return 'Krakenless knows of no remote to publish to. Add one with git remote add, then fetch.';
  }
  return null;
}

/**
 * The question the merge-pull asks, and the confirmation reason it mints.
 *
 * Spelled out in full because this is the one place the app writes a merge
 * commit the user did not start from a commit menu: the sentence has to say
 * what will be merged into what, that nothing is rewritten, and what a
 * conflicted stop looks like — those are the terms the confirmation token
 * records the user as having agreed to.
 */
export function pullMergeQuestion(
  branch: string,
  upstream: UpstreamRef,
  counts: { ahead: number; behind: number },
): string {
  const remoteRef = `${upstream.remote}/${upstream.branch}`;
  return (
    `${branch} and ${remoteRef} have diverged: yours has ${plural(counts.ahead)} ` +
    `${remoteRef} does not, and theirs has ${plural(counts.behind)} yours does not. ` +
    `Pulling will fetch and merge ${remoteRef} into ${branch}, adding a merge commit. ` +
    `No commit is rewritten, and a merge that stops on conflicts can be aborted from the conflict banner.`
  );
}

function plural(count: number): string {
  return count === 1 ? '1 commit' : `${count} commits`;
}

/** Exactly what a push would send, or `null` when it must not run at all. */
export interface PushIntent {
  remote: string;
  branch: string;
  setUpstream?: true;
}

/**
 * The push decision, derived rather than read off the rendered button.
 *
 * `pushBlock` is what greys the button out, but a `disabled` attribute is a
 * rendering detail; the refusals it encodes — a detached HEAD, a merge in
 * progress, an upstream whose branch has another name — are the difference
 * between pushing where the user was shown and pushing somewhere else. So the
 * click path re-derives the intent from the same gate and gets `null` for
 * every case the button was supposed to refuse.
 */
export function pushIntent(gate: Gate): PushIntent | null {
  if (pushBlock(gate) !== null) return null;

  if (gate.upstream.kind === 'no-upstream') {
    return gate.publishRemote === null
      ? null
      : { remote: gate.publishRemote, branch: gate.upstream.branch, setUpstream: true };
  }
  if (gate.upstream.kind !== 'tracking') return null;
  return { remote: gate.upstream.upstream.remote, branch: gate.upstream.branch };
}

function sharedBlock(gate: Gate): string | null {
  if (!gate.repoOpen) return 'No repository is open.';
  if (gate.busy) return 'Another git operation is already running.';
  if (gate.statusState === 'loading') {
    return 'Waiting for the branch status — Krakenless will not act on an unread repository.';
  }
  if (gate.statusState === 'idle') return 'The branch status has not been read yet.';
  if (gate.statusState === 'error') {
    return 'The branch status could not be read, so Krakenless does not know what this branch tracks.';
  }
  if (gate.hasConflicts) {
    return 'A merge is in progress with unresolved conflicts. Resolve them and commit first.';
  }
  return null;
}
