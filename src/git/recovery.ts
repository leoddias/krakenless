/**
 * Building the command that undoes a discard.
 *
 * Pure, and separated from the git calls, because this string is the only route
 * back to work the app just removed from disk. Two facts about `git stash` make
 * the naive version wrong, and both were found by running real git rather than
 * by reading the docs:
 *
 * 1. `stash push --include-untracked` does **not** put untracked files in the
 *    stash commit's tree — they live in its third parent. Restoring from the
 *    stash oid errors with "pathspec did not match".
 * 2. A path the stash recorded as *deleted* is likewise absent from the tree,
 *    so naming it in the restore makes the whole command abort — including for
 *    the paths that would have worked.
 */

/** Quotes a path for a command line the user copies into their own shell. */
export function quotePath(path: string): string {
  return `"${path.replace(/(["$`\\])/g, '\\$1')}"`;
}

export interface RecoveryPlan {
  /** Runnable commands, in order. Empty when nothing can be restored this way. */
  commands: string[];
  /**
   * Paths the stash holds but this route cannot restore — the caller must say
   * so instead of implying every path came back.
   */
  unrecoverable: string[];
}

/**
 * Builds the recovery for one stash phase.
 *
 * `sourceOid` must be the oid whose tree actually contains the content (for an
 * untracked phase, the third parent already resolved). `presentPaths` is what
 * that tree really holds — anything else is reported rather than named, because
 * `git restore` aborts wholesale on a pathspec it cannot match.
 */
export function recoveryFor(
  sourceOid: string,
  requestedPaths: string[],
  presentPaths: readonly string[],
): RecoveryPlan {
  const present = new Set(presentPaths);
  const restorable = requestedPaths.filter((path) => present.has(path));
  const missing = requestedPaths.filter((path) => !present.has(path));

  const commands =
    restorable.length === 0
      ? []
      : [
          // `restore --worktree` and not `checkout <oid> -- <path>`: the latter
          // writes the index too, destroying the staged snapshot the discard
          // deliberately kept.
          `git restore --source=${sourceOid} --worktree -- ${restorable
            .map(quotePath)
            .join(' ')}`,
        ];

  return { commands, unrecoverable: missing };
}

/**
 * One sentence naming what the recovery cannot bring back, or `null` when it
 * covers everything.
 */
export function unrecoverableNote(stashOid: string, paths: string[]): string | null {
  if (paths.length === 0) return null;
  return `The stash ${stashOid} also holds ${paths
    .map(quotePath)
    .join(
      ', ',
    )}, which this command cannot restore — inspect it with \`git stash show -p ${stashOid}\`.`;
}
