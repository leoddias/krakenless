/**
 * What a double click does on a row whose only branch is a remote-tracking one.
 *
 * `git switch origin/main` detaches HEAD, which is the one outcome a double
 * click must never produce (ADR-0061). What the user means by it is the local
 * branch that stands for `origin/main`: the one tracking it if there is one,
 * else the one sharing its name, else a new one. And they mean it *at that
 * commit* — the picture the click was aimed at is `origin/main` ahead of a
 * `main` that fell behind, and landing on the stale `main` would read as the
 * click not working. So an existing branch is moved forward to the remote,
 * and only forward: a branch with commits of its own is git's refusal, never a
 * merge nobody asked for (ADR-0062).
 *
 * Pure: the rule that decides whether a double click moves the working tree
 * and which branch it writes to is asserted on its own.
 */

import type { Branch, CommitRef } from '../../git/types';
import type { RemoteSwitch } from '../../state/actions';
import { localNameFor, splitRemoteBranch } from '../refs/labels';

/**
 * The switch a double click on this row asks for, or `null` when it asks for
 * nothing: no remote-tracking chip on the row, or the branch list not read yet,
 * or the branch that stands for it already checked out at this very commit.
 *
 * `branches` is the whole list from the refs panel; only local rows are looked
 * at, and the remote-tracking row for the chip is found there too so the local
 * name is derived by the same rule the panel's "Check out" button uses.
 */
export function remoteSwitchFor(
  refs: CommitRef[],
  oid: string,
  branches: Branch[] | null,
): RemoteSwitch | null {
  const chip = refs.find((ref) => ref.kind === 'remote-branch');
  if (chip === undefined || branches === null) return null;
  const remoteRef = chip.name;

  const locals = branches.filter((branch) => !branch.remote);
  const tracking = locals.find((branch) => branch.upstream === remoteRef);
  const remoteRow = branches.find((branch) => branch.remote && branch.name === remoteRef);
  // `origin/HEAD` is a pointer, not a branch: `splitRemoteBranch` says so, and
  // no local branch is ever named after it.
  const derived =
    remoteRow === undefined || splitRemoteBranch(remoteRef) === null
      ? null
      : localNameFor(remoteRow);
  // The namesake counts only when it does not track somewhere else: a `main`
  // that follows `upstream/main` is not what `origin/main` stands for, and
  // moving it toward a fork is a write to a branch the user's config named
  // differently.
  const namesake =
    derived === null ? undefined : locals.find((branch) => branch.name === derived);
  const namesakeStandsIn =
    namesake !== undefined &&
    (namesake.upstream === undefined || namesake.upstream === remoteRef);
  const local = tracking ?? (namesakeStandsIn ? namesake : undefined);

  if (local !== undefined) {
    // Already there: the checkout is this branch and it sits on this commit.
    if (local.current && local.oid === oid) return null;
    return { kind: 'forward', name: local.name, remoteRef, current: local.current };
  }
  // A namesake that follows another remote also takes the name a new branch
  // would need, so there is nothing to create either.
  if (derived === null || namesake !== undefined) return null;
  return { kind: 'create', name: derived, remoteRef };
}
