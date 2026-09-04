import { assertRefName } from '../argsafety';
import type { GitCommand } from '../types';

/**
 * Builders for network operations.
 *
 * Network commands get a much longer timeout than local ones: a fetch over a
 * slow link is not a hung process, and killing it at the default 30s would look
 * like a failure the user cannot explain.
 */
const NETWORK_TIMEOUT_MS = 300_000;

/** Lists remotes with both URLs, one line per direction. */
export function buildRemoteListCommand(): GitCommand {
  return { args: ['remote', '--verbose'] };
}

export interface FetchOptions {
  remote?: string;
  /** Removes local refs whose remote branch is gone. */
  prune?: boolean;
}

/**
 * Fetches, following the tags that point into the history being fetched.
 *
 * No `--no-tags`, which is what this used to pass and what made a tag somebody
 * else pushed invisible here forever: the release the whole team is talking
 * about simply did not exist in this app. Git's default is the honest middle —
 * a tag arrives when the commit it names does, and a tag on a branch nobody
 * fetched stays where it is. `--tags` is deliberately not passed either: it
 * pulls down every tag the remote has ever had, which on an old repository is
 * thousands of refs nobody asked for.
 *
 * `--prune` is paired with an explicit `--no-prune-tags`, and that pairing is
 * not decoration. `fetch.pruneTags=true` in the user's own config — a line
 * plenty of dotfiles carry — makes a plain `--prune` delete `refs/tags/*` that
 * the remote does not have, and a tag created here and never pushed is exactly
 * that. On a five-minute background timer that is silent data loss: the tag is
 * often the only name on a commit, and an unreferenced commit is eventually
 * collected. A tag that vanished upstream is not evidence it should vanish
 * here, and nothing in this app deletes a ref without being asked.
 */
export function buildFetchCommand(options: FetchOptions = {}): GitCommand {
  const args = ['fetch', '--progress'];
  if (options.prune === true) args.push('--prune', '--no-prune-tags');
  args.push(options.remote === undefined ? '--all' : assertRefName(options.remote));
  return { args, timeoutMs: NETWORK_TIMEOUT_MS };
}

/**
 * Pulls with `--ff-only`.
 *
 * A pull that can only fast-forward either succeeds cleanly or stops and says
 * why. The alternative — an implicit merge or rebase — makes a decision on the
 * user's behalf that can leave the repository mid-operation with conflicts they
 * did not ask for. Divergence is surfaced as an error and handled explicitly.
 *
 * `--autostash` for the reason the rebase carries it (ADR-0042): git refuses
 * to pull over a working tree whose files the pull would touch, and relaying
 * that refusal sends the user to a terminal to stash by hand. Git's own answer
 * is to stash before and restore after, and on a clean tree it costs nothing.
 * When the restore conflicts git says so and exits 0 — `pull` reads for it.
 */
export function buildPullCommand(): GitCommand {
  return {
    args: ['pull', '--ff-only', '--autostash', '--progress'],
    timeoutMs: NETWORK_TIMEOUT_MS,
  };
}

/**
 * Pulls with an explicit merge — the escape hatch for a diverged branch.
 *
 * This is the operation `buildPullCommand` deliberately refuses to do
 * implicitly. It exists so divergence has an in-app resolution instead of a
 * dead end: fast-forward when possible, a merge commit when not. `--no-rebase`
 * pins the strategy against a `pull.rebase` config, because the confirmation
 * the user answered described a merge, not a rebase that rewrites their
 * commits. `--ff` pins it against `pull.ff=only` — without it, the very
 * config that surfaced the divergence would make the escape hatch refuse
 * too, and confirming would loop back to the same error forever. `--no-edit`
 * for the same reason merge has it: there is no terminal to host an editor.
 *
 * Not marked destructive for the reason merge is not: it only adds commits,
 * `ORIG_HEAD` names where the branch was, and a conflicted stop is undone by
 * `git merge --abort`. The confirmation this operation gets is the UI's.
 */
export function buildPullMergeCommand(): GitCommand {
  return {
    args: ['pull', '--no-rebase', '--ff', '--no-edit', '--autostash', '--progress'],
    timeoutMs: NETWORK_TIMEOUT_MS,
  };
}

export interface PushOptions {
  remote: string;
  branch: string;
  /** Publishes a branch that has no upstream yet. */
  setUpstream?: boolean;
  /**
   * Force with lease: refuses if the remote moved since our last fetch. Plain
   * `--force` is deliberately not offered anywhere in this app.
   *
   * Not safe to expose in the UI until the lease carries an explicit
   * `<branch>:<oid>` — the bare form leases against the local remote-tracking
   * ref, so it is only as fresh as the last fetch. Wire the oid the UI showed
   * the user at the same time as the confirmation dialog.
   */
  forceWithLease?: boolean;
}

export function buildPushCommand(options: PushOptions): GitCommand {
  const args = ['push', '--progress'];
  if (options.setUpstream === true) args.push('--set-upstream');
  if (options.forceWithLease === true) args.push('--force-with-lease');

  const branch = assertRefName(options.branch);
  args.push(assertRefName(options.remote));
  // An explicit, fully-qualified refspec. A bare branch token would let a name
  // like `+main` be read as a force refspec, and a name like `refs/heads/x`
  // resolve somewhere unintended.
  args.push(`refs/heads/${branch}:refs/heads/${branch}`);
  return {
    args,
    destructive: options.forceWithLease === true,
    timeoutMs: NETWORK_TIMEOUT_MS,
  };
}

/**
 * Publishes one tag to a remote.
 *
 * A tag is created locally and then exists nowhere else: `git push` does not
 * carry tags along with commits, which is why a release tag so often lives on
 * one laptop until somebody notices.
 *
 * Fully qualified on both sides, for the reason the branch push is: a tag named
 * `+v1.0` would otherwise be read as a force refspec, and one named
 * `refs/tags/x` would resolve somewhere nobody meant. Never `--force`: a tag
 * that already exists on the remote is a name other people have already
 * fetched, and moving it is the kind of edit that shows up in no diff. Git's
 * refusal is reported instead.
 */
export function buildPushTagCommand(remote: string, tag: string): GitCommand {
  const name = assertRefName(tag);
  return {
    args: [
      'push',
      '--progress',
      assertRefName(remote),
      `refs/tags/${name}:refs/tags/${name}`,
    ],
    timeoutMs: NETWORK_TIMEOUT_MS,
  };
}

/** Aborts an in-progress merge, returning the tree to its pre-merge state. */
export function buildMergeAbortCommand(): GitCommand {
  return { args: ['merge', '--abort'], destructive: true };
}
