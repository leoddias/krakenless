/**
 * Builder for reading every ref a fetch can move.
 *
 * A fetch that changed nothing and a fetch that never ran look identical from
 * the outside — git says as little as it can, and its progress output is
 * meant for humans, not for parsing. Taking a snapshot of the refs before and
 * after answers the question exactly, in the repository's own terms, and works
 * the same on every git version and in every language.
 *
 * Only what a fetch writes is listed: remote-tracking refs and tags. Local
 * branches, HEAD and the working tree cannot move under a fetch, so reading
 * them would only add noise.
 */

import type { GitCommand } from '../types';

/**
 * Lists `refs/remotes` and `refs/tags` as `<oid> <refname>`, one per line.
 *
 * `%(objectname)` rather than `%(*objectname)`: for an annotated tag this is
 * the tag object, so re-tagging the same commit with a new message still reads
 * as a change — which it is. The separator is a single space and refnames
 * cannot contain one, so the line splits unambiguously at the first space.
 */
export function buildRefSnapshotCommand(): GitCommand {
  return {
    args: [
      'for-each-ref',
      '--format=%(objectname) %(refname)',
      'refs/remotes',
      'refs/tags',
    ],
  };
}
