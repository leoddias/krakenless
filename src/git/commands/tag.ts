/**
 * Builders for reading and deleting tags.
 *
 * A tag is the one ref in this app that names something on purpose *forever*:
 * a release, a submission, a point somebody else's script fetches by name.
 * Deleting one is therefore not the same act as deleting a branch — git has no
 * "this tag is merged" refusal to fall back on, because merging says nothing
 * about a tag. `tag -d` removes the ref and nothing else, so the object it
 * pointed at survives until git collects it, and `update-ref` puts the name
 * back on that exact object (see {@link buildTagListCommand} for why the object
 * id is read and kept).
 *
 * Creating tags lives in `history.ts`, next to the other operations offered on
 * a commit; this file is the half the refs panel needs.
 */

import { assertRefName } from '../argsafety';
import type { GitCommand } from '../types';

/**
 * Field separator for `for-each-ref`. `%00` is a NUL, which cannot appear in a
 * ref name, so no tag name can forge a record boundary.
 *
 * `%(objectname)` is what the *ref* points at — the tag object for an
 * annotated tag, the commit for a lightweight one — and `%(*objectname)` is
 * the commit an annotated tag dereferences to, empty for a lightweight one.
 * Both are needed and they are not interchangeable: the commit is what the
 * history has a row for, and the object is what a delete would have to be
 * given back to restore the tag as it was, message and all.
 */
export const TAG_FORMAT = [
  // Full refname, *not* `%(refname:short)`. Git's shortening is ambiguity-aware:
  // with both `refs/heads/release` and `refs/tags/release` present it prints the
  // tag as `tags/release`, which is the one case this file exists to get right.
  // A row labelled `tags/release` cannot be deleted (`git tag --delete
  // tags/release` finds nothing) and its restore command would create a nested
  // `refs/tags/tags/release`. The prefix is stripped in `parsers/tag.ts`, the
  // same trick `BRANCH_FORMAT` uses.
  '%(refname)',
  '%(objectname)',
  '%(objecttype)',
  '%(*objectname)',
  '%(creatordate:iso-strict)',
  '%(contents:subject)',
].join('%00');

/**
 * Lists every tag, newest version first.
 *
 * `v:refname` is git's version sort, so `v1.10` comes after `v1.9` instead of
 * before it the way a plain string sort puts it — on a list of releases that
 * is the difference between the top row being the current one and being an
 * arbitrary one.
 */
export function buildTagListCommand(): GitCommand {
  return {
    args: ['for-each-ref', `--format=${TAG_FORMAT}`, '--sort=-v:refname', 'refs/tags'],
  };
}

/**
 * Deletes a tag locally.
 *
 * Destructive, and flagged as such although nothing about it touches a commit:
 * the name is the artifact here, and git offers no safe form of this the way
 * `branch -d` is the safe form of `branch -D`. `--delete` is spelled out rather
 * than `-d` so the argument-derived gate in `destructive.ts` and a human
 * reading a log see the same word.
 */
export function buildDeleteTagCommand(name: string): GitCommand {
  return { args: ['tag', '--delete', assertRefName(name)], destructive: true };
}
