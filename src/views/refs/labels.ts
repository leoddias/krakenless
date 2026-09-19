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

import { BRANCH_NOUN, refNameError, refPath } from '../shell/refName';
import type { Branch, StashEntry, Tag } from '../../git/types';

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

/** The ref path a branch row stands for: what a selection names it by. */
export function branchRef(branch: Branch): string {
  return refPath(branch.remote ? 'remote-branch' : 'branch', branch.name);
}

/** The ref path a tag row stands for. */
export function tagRef(tag: Tag): string {
  return refPath('tag', tag.name);
}

/**
 * Whether a row is the one the panels are showing.
 *
 * A ref path when the selection was made through a ref, and only then. Several
 * refs routinely point at one commit — a freshly pushed branch, its
 * remote-tracking twin and the release tag on the same commit — and matching on
 * the oid lights all of them up, which answers a question nobody asked: the
 * click named one of them. The oid stays as the fallback for a selection that
 * came from somewhere with no ref to name: a commit row, a stash, a search
 * result.
 *
 * The comparison is on the *path*, not the short name, because the short names
 * collide: git allows a branch and a tag both called `release`, and a delete
 * offered against the wrong one of those is the mistake this panel must not
 * make.
 */
export function isRefSelected(
  ref: { path: string; oid: string },
  selectedRef: string | null,
  selectedOid: string | null,
): boolean {
  return selectedRef === null
    ? selectedOid !== null && selectedOid === ref.oid
    : selectedRef === ref.path;
}

/** {@link isRefSelected} for a branch row. */
export function isBranchSelected(
  branch: Branch,
  selectedRef: string | null,
  selectedOid: string | null,
): boolean {
  return isRefSelected(
    { path: branchRef(branch), oid: branch.oid },
    selectedRef,
    selectedOid,
  );
}

/** {@link isRefSelected} for a tag row. */
export function isTagSelected(
  tag: Tag,
  selectedRef: string | null,
  selectedOid: string | null,
): boolean {
  return isRefSelected({ path: tagRef(tag), oid: tag.oid }, selectedRef, selectedOid);
}

/**
 * Every `/`-separated prefix of a branch name, outermost first.
 *
 * `feat/ui/tabs` → `feat`, `feat/ui`. These are the tree rows that have to be
 * open for that branch to be on screen, which is what a selection arriving
 * from the history has to unfold before it can highlight anything.
 */
export function branchAncestors(name: string): string[] {
  const segments = name.split('/').filter((part) => part.length > 0);
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
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
 * The rules live in `views/shell/refName.ts`, which branch and tag names share
 * — git checks both with `git check-ref-format`, and two copies of that list
 * would drift.
 */
export function branchNameError(name: string): string | null {
  return refNameError(name, BRANCH_NOUN);
}

/** Object ids as git prints them: hex, SHA-1 or SHA-256 length. */
const OID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/**
 * Ref names safe to put in a command the user is invited to paste into a shell.
 *
 * Narrower than what git accepts on purpose. `assertRefName` refuses what would
 * confuse *git* — a leading dash, a space, `~ ^ : ? * [ \` — and lets through
 * `;`, `$`, a backtick, `|`, `&` and quotes, which git is happy with and a
 * shell is not. A tag arriving from someone else's repository is attacker-named
 * text, and a recovery line reading
 * `git update-ref refs/tags/v1;rm -rf ~ <oid>` under a label that says "run
 * this to undo" is a command the user has been told to trust.
 *
 * Nothing in this app ever executes these strings, so the answer to a name that
 * does not fit is to offer no command at all rather than to quote it: a quoting
 * scheme has to be right for the user's shell, and this code does not know
 * which one that is.
 */
const SHELL_SAFE_REF = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/** True when both halves of a recovery command can be shown as typed. */
function pasteable(name: string, oid: string): boolean {
  return OID.test(oid) && SHELL_SAFE_REF.test(name) && !name.includes('..');
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

/**
 * What the local tag question explains, under the question itself.
 *
 * Here rather than in each panel because two panels ask it — the tag row and
 * the commit row's menu — and a sentence about what a delete costs must not
 * differ between the two places that ask it. `restore` is the command that
 * would put it back, or `null`: the promise of a way back is only made when
 * there is one to make.
 */
export function deleteTagDetail(restore: string | null): string {
  const base =
    'This removes the name, not the commit. The tag stays on any remote it was pushed to.';
  return restore === null
    ? `${base} Krakenless has no way back to offer for this one, and a tag has no reflog.`
    : `${base} Krakenless will offer the command that puts it back here.`;
}

/**
 * What the remote tag question explains.
 *
 * It does not say the tag "disappears from everyone's next fetch", because that
 * is not what git does: a plain `git fetch` never removes a tag somebody
 * already has — that needs `--prune-tags`. What it does stop is anyone getting
 * it from here again.
 */
export function deleteRemoteTagDetail(remote: string): string {
  return `Nobody will get this tag from ${remote} again — a fresh clone or fetch will not have it, and anything that builds from it by name stops finding it. Copies already fetched stay where they are until someone runs \`git fetch --prune-tags\`.`;
}

/** Question the tag delete asks. Also the confirmation reason. */
export function deleteTagQuestion(name: string): string {
  return `Delete tag "${name}"?`;
}

/**
 * The question a remote tag delete asks, and the reason it mints.
 *
 * It says "for everyone" for the reason the remote branch question does, and
 * the consequence is sharper: a release tag is fetched by scripts as well as by
 * people, and the name disappearing is what a build that pins to it sees.
 */
export function deleteRemoteTagQuestion(ref: RemoteTagRef): string {
  return `Delete tag "${ref.tag}" from ${ref.remote} — for everyone who uses that remote?`;
}

/** A tag on a remote, split the way a push needs it. */
export interface RemoteTagRef {
  remote: string;
  tag: string;
}

/**
 * How to put a deleted tag back, or `null` when no command can be offered.
 *
 * `update-ref` rather than `git tag`: the object handed in is what the ref
 * pointed at, which for an annotated tag is the tag object carrying the
 * message and the tagger — `git tag <name> <object>` would resolve that to the
 * commit and recreate a *lightweight* tag, quietly dropping the annotation.
 * The shape is checked because this string is handed to the user to paste into
 * a shell.
 */
export function tagRestoreCommand(tag: Tag): string | null {
  return pasteable(tag.name, tag.object)
    ? `git update-ref refs/tags/${tag.name} ${tag.object}`
    : null;
}

/**
 * How to put a tag back on a remote, or `null` when no command can be offered.
 *
 * The object is the one this repository still has; after it is collected there
 * is nothing left to push. Fully qualified on the right-hand side so the push
 * cannot land on a branch of the same name.
 */
export function remoteTagDeleteRecovery(
  ref: RemoteTagRef,
  object: string,
): string | null {
  return pasteable(ref.tag, object) && SHELL_SAFE_REF.test(ref.remote)
    ? `git push ${ref.remote} ${object}:refs/tags/${ref.tag}`
    : null;
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
 * How to get a dropped stash back, or `null` when no command can be offered.
 *
 * `git stash drop` only deletes the ref; the commit survives until git collects
 * it, and its oid is the only way to name it afterwards — which is why this
 * names the oid the panel acted on rather than the `stash@{n}` index that has
 * already shifted. The shape is checked because this string is handed to the
 * user to paste into a shell: an oid that is not an oid must not travel there
 * as if it were one.
 */
export function dropRecoveryCommand(oid: string): string | null {
  return OID.test(oid) ? `git stash apply ${oid}` : null;
}

/** A remote-tracking branch split into the two halves a push needs. */
export interface RemoteRef {
  remote: string;
  branch: string;
}

/**
 * Splits `origin/feature/x` into `origin` + `feature/x`.
 *
 * The first slash is the only split git gives us, and it is right for every
 * remote git itself creates. `null` for anything that does not have a non-empty
 * name on both sides, and for `<remote>/HEAD`, which is a symref rather than a
 * branch: deleting a branch the user misread is precisely the mistake this
 * panel must not make, so an unparsable name gets no delete button at all.
 */
export function splitRemoteBranch(name: string): RemoteRef | null {
  const slash = name.indexOf('/');
  if (slash <= 0) return null;
  const remote = name.slice(0, slash);
  const branch = name.slice(slash + 1);
  if (branch.length === 0 || branch === 'HEAD') return null;
  return { remote, branch };
}

/**
 * The question a remote delete asks, and the confirmation reason it mints.
 *
 * It says "for everyone" because that is the whole difference from the local
 * delete two rows above it: this one reaches a server other people fetch from,
 * and the branch disappears from their next fetch whether or not they were
 * working on it.
 */
export function deleteRemoteBranchQuestion(ref: RemoteRef): string {
  return `Delete "${ref.branch}" from ${ref.remote} — for everyone who uses that remote?`;
}

/**
 * How to put a deleted remote branch back, or `null` when no command can be
 * offered.
 *
 * The oid is the one the panel had on screen for that branch. Deleting a
 * remote branch removes the *name*: the commits stay on the server until it
 * collects them, and in this repository they are right here, because a
 * remote-tracking ref pointing at them is what the row was drawn from. So the
 * way back is one push, and it is worth saying while the number is still known
 * — after the next fetch prunes the ref, nothing in the app remembers it.
 */
export function remoteDeleteRecovery(ref: RemoteRef, oid: string): string | null {
  return pasteable(ref.branch, oid) && SHELL_SAFE_REF.test(ref.remote)
    ? `git push ${ref.remote} ${oid}:refs/heads/${ref.branch}`
    : null;
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
