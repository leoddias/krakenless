/**
 * Parsing `git for-each-ref --format=%(objectname) %(refname)`.
 *
 * The output is one ref per line, `<oid> <refname>`. Nothing here throws: a
 * snapshot is used to decide whether a background fetch brought news, and a
 * line nobody can read is not worth failing a fetch over. Unreadable lines are
 * skipped, and the caller sees a snapshot without them.
 */

/** Ref name to the oid it points at, for the refs a fetch can move. */
export type RefSnapshot = ReadonlyMap<string, string>;

/**
 * `refs/remotes/<remote>/HEAD` is deliberately dropped.
 *
 * It is a symbolic ref standing for the remote's default branch, so it moves
 * whenever that branch moves and would report "origin/HEAD updated" alongside
 * every "origin/main updated" — the same news twice, with a name no user
 * thinks of as a branch.
 */
function isNoise(refname: string): boolean {
  return refname.startsWith('refs/remotes/') && refname.endsWith('/HEAD');
}

export function parseRefSnapshot(stdout: string): RefSnapshot {
  const refs = new Map<string, string>();
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.length === 0) continue;

    const space = line.indexOf(' ');
    if (space <= 0) continue;

    const oid = line.slice(0, space);
    const refname = line.slice(space + 1);
    if (refname.length === 0 || isNoise(refname)) continue;

    refs.set(refname, oid);
  }
  return refs;
}
