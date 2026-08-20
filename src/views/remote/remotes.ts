/**
 * Pure helpers behind the remote toolbar.
 *
 * They exist as functions rather than inline JSX for one reason: every claim
 * this panel makes about the repository ("2 ahead", "no upstream", "you are
 * not on a branch") is a claim a user acts on with a network operation, so
 * each one is derived by something that can be unit tested on its own.
 */

import type { Branch, RepoStatus } from '../../git/types';
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
      ahead: number;
      behind: number;
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
    ahead: value.ahead,
    behind: value.behind,
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
          'This branch is not tracking anything yet. Publish it to create it on a remote.',
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

function countsSentence(ahead: number, behind: number): string {
  if (ahead === 0 && behind === 0)
    return 'Up to date with its upstream, as of the last fetch.';
  const parts: string[] = [];
  if (ahead > 0) parts.push(`${ahead} ahead`);
  if (behind > 0) parts.push(`${behind} behind`);
  return `${parts.join(', ')}, as of the last fetch.`;
}

/**
 * Remote names the app can name with certainty, from the branch list.
 *
 * The store has no remote list, so these are recovered from remote-tracking
 * branches and from the upstreams of local ones. `origin` sorts first because
 * it is the conventional default; the rest are alphabetical so the order does
 * not shift under the cursor between reads.
 */
export function candidateRemotes(branches: Loadable<Branch[]>): string[] {
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
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  return sorted.sort((a, b) => Number(b === 'origin') - Number(a === 'origin'));
}

/** Everything the gates need to know, gathered in one place for testability. */
export interface Gate {
  repoOpen: boolean;
  busy: boolean;
  statusState: Loadable<RepoStatus>['state'];
  hasConflicts: boolean;
  upstream: UpstreamState;
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
      return gate.publishRemote === null
        ? 'Krakenless knows of no remote to publish to. Add one with `git remote add`, then fetch.'
        : null;
    case 'tracking':
      // The push builder always writes `refs/heads/<name>:refs/heads/<name>`,
      // so a branch tracking a differently-named upstream would be pushed to a
      // *different* branch than the one whose counts are on screen. Refuse
      // rather than publish commits somewhere the user was not shown.
      return gate.upstream.upstream.branch === gate.upstream.branch
        ? null
        : `This branch tracks ${gate.upstream.upstream.remote}/${gate.upstream.upstream.branch}, which has a different name. Krakenless only pushes a branch to its own name, so push this one from the command line: git push ${gate.upstream.upstream.remote} ${gate.upstream.branch}:${gate.upstream.upstream.branch}`;
  }
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
