/**
 * Wording, grouping and field validation for the refs panel.
 *
 * Pure and separate from the component for two reasons. The confirmation
 * questions are not decoration: the string shown to the user is the same string
 * handed to the action layer as the confirmation reason, so it becomes the
 * token the git layer checks. Testing them here proves the user was asked about
 * the exact branch or stash that is about to be touched. And the branch-name
 * check mirrors `src/git/argsafety.ts` so a name like `--force` is refused in
 * the field, next to the input, instead of travelling down to the git layer and
 * coming back as an opaque failure.
 */

import type { Branch, StashEntry } from '../../git/types';

export interface BranchGroups {
  local: Branch[];
  remote: Branch[];
}

/**
 * Splits branches into the two sections the panel shows.
 *
 * Order is git's (`for-each-ref` sorts by refname) except that the current
 * branch is pulled to the top of the local list: it is the one the user needs
 * to find without reading, and it is the one they must never delete by aiming
 * at the wrong row.
 */
export function groupBranches(branches: readonly Branch[]): BranchGroups {
  const local = branches.filter((branch) => !branch.remote);
  const remote = branches.filter((branch) => branch.remote);
  local.sort((a, b) => Number(b.current) - Number(a.current));
  return { local, remote };
}

/**
 * Local branch name a remote-tracking branch would be checked out as, or `null`
 * when one cannot be derived.
 *
 * `git switch origin/main` does not check out a remote branch — the row has to
 * offer creating `main` *from* `origin/main` instead, which is the only form
 * that also records the upstream. The remote prefix is the first path segment
 * of the short name git printed (`origin/feature/x` → `feature/x`).
 */
export function localNameFor(branch: Branch): string | null {
  if (!branch.remote) return null;
  const slash = branch.name.indexOf('/');
  if (slash === -1) return null;
  const local = branch.name.slice(slash + 1);
  return branchNameError(local) === null ? local : null;
}

/** Upstream and divergence, spelled out for the row's tooltip. */
export function trackingSummary(branch: Branch): string {
  if (branch.upstream === undefined) return 'No upstream branch';
  const parts = [`Tracks ${branch.upstream}`];
  if (branch.ahead > 0) parts.push(`${branch.ahead} ahead`);
  if (branch.behind > 0) parts.push(`${branch.behind} behind`);
  if (branch.ahead === 0 && branch.behind === 0) parts.push('up to date');
  return parts.join(', ');
}

/**
 * Why this branch name cannot be used, or `null` when it can.
 *
 * A deliberate mirror of `assertRefName` in `src/git/argsafety.ts`, which stays
 * the authority — this exists so the rejection lands on the field the user is
 * typing in rather than as a failed command.
 */
export function branchNameError(name: string): string | null {
  if (name.length === 0) return 'Enter a branch name.';
  if (name.startsWith('-')) return 'A branch name may not start with a dash.';
  if (name.startsWith('+')) return 'A branch name may not start with a plus.';
  if (name.startsWith('refs/')) {
    return 'Use the short name, not a full ref path like "refs/heads/main".';
  }
  if (/[\s~^:?*[\\]/.test(name)) {
    return 'A branch name may not contain spaces or any of ~ ^ : ? * [ \\.';
  }
  if (name.includes('..')) return 'A branch name may not contain "..".';
  if (name.includes('@{')) return 'A branch name may not contain "@{".';
  if (name.endsWith('.') || name.endsWith('/') || name.endsWith('.lock')) {
    return 'A branch name may not end with ".", "/" or ".lock".';
  }
  if (name.startsWith('/') || name.includes('//')) {
    return 'A branch name may not have an empty path component.';
  }
  if (name === '@') return 'A branch name may not be "@".';
  return null;
}

/** Question the first delete step asks. Also the confirmation reason. */
export function deleteBranchQuestion(name: string): string {
  return `Delete branch "${name}"?`;
}

/**
 * Question the second delete step asks, after git refused the safe delete.
 *
 * It names the consequence the first question could not know about: `-D` drops
 * commits that exist nowhere else. It is a separate string because it is a
 * separate answer — the reason travelling with the forced delete must be the
 * one the user gave *after* reading the warning.
 */
export function forceDeleteBranchQuestion(name: string): string {
  return `Delete branch "${name}" anyway, dropping the commits that are not merged anywhere?`;
}

/** Short label for a stash, falling back to its ref when git recorded no message. */
export function stashLabel(entry: StashEntry): string {
  return entry.message.length > 0 ? entry.message : entry.ref;
}

export function applyStashQuestion(entry: StashEntry): string {
  return `Apply stash "${stashLabel(entry)}" to the working tree, keeping it in the list?`;
}

export function popStashQuestion(entry: StashEntry): string {
  return `Pop stash "${stashLabel(entry)}" — apply it to the working tree and remove it from the list?`;
}

export function dropStashQuestion(entry: StashEntry): string {
  return `Drop stash "${stashLabel(entry)}" without applying it?`;
}

/**
 * How to get a dropped stash back.
 *
 * `git stash drop` only deletes the ref; the commit survives until git
 * collects it, and its oid is the only way to name it afterwards — which is
 * why the panel shows the oid it acted on rather than the `stash@{n}` index
 * that has already shifted.
 */
export function dropRecoveryCommand(oid: string): string {
  return `git stash apply ${oid}`;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** Average lengths — good enough for "3 months ago", never used for maths. */
const MONTH = 30.436875 * DAY;
const YEAR = 365.2425 * DAY;

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'always' });

/**
 * Formats an ISO 8601 date relative to `now`. Unparsable input is returned
 * verbatim: a stash with an odd date is better shown raw than shown wrong.
 */
export function formatRelativeDate(iso: string, now: Date): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;

  const elapsed = now.getTime() - time;
  const magnitude = Math.abs(elapsed);
  if (magnitude < MINUTE) return 'just now';

  const [unit, size] = pickUnit(magnitude);
  // Floor, so an elapsed unit is never rounded up to one that has not passed
  // yet; Intl wants a negative value for the past.
  const value = Math.floor(magnitude / size);
  return relative.format(elapsed < 0 ? value : -value, unit);
}

function pickUnit(magnitude: number): [Intl.RelativeTimeFormatUnit, number] {
  if (magnitude < HOUR) return ['minute', MINUTE];
  if (magnitude < DAY) return ['hour', HOUR];
  if (magnitude < WEEK) return ['day', DAY];
  if (magnitude < MONTH) return ['week', WEEK];
  if (magnitude < YEAR) return ['month', MONTH];
  return ['year', YEAR];
}
