/**
 * Parser for `for-each-ref` over `refs/tags`, built with `TAG_FORMAT`.
 *
 * Separate from the branch parser because the records are a different shape and
 * one of the fields is load-bearing in a way no branch field is: an annotated
 * tag reports the *tag object* as `%(objectname)` and the commit only as
 * `%(*objectname)`. A parser that took the first for "the commit" would give
 * the panel an oid no row in the history has, so selecting the tag would show
 * nothing and a restore would recreate the tag pointing at itself.
 */

import { GitError } from '../errors';
import type { Tag } from '../types';

const FIELDS_PER_TAG = 6;

function fail(message: string): never {
  throw new GitError('parse-failed', message);
}

/** Parses tag records into the list the refs panel draws. */
export function parseTags(stdout: string): Tag[] {
  const tags: Tag[] = [];

  for (const line of stdout.split('\n')) {
    const record = line.replace(/\r$/, '');
    if (record.length === 0) continue;

    const fields = record.split('\0');
    if (fields.length !== FIELDS_PER_TAG) {
      fail(`Expected ${FIELDS_PER_TAG} fields per tag, got ${fields.length}`);
    }
    const [fullRef, object, type, peeled, date, subject] = fields as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (fullRef.length === 0 || object.length === 0) {
      fail('Tag record is missing a name or object id');
    }
    // Stripped here rather than asked of git: `%(refname:short)` disambiguates
    // against a branch of the same name by printing `tags/release`, a name no
    // `git tag` command answers to. The prefix is a constant, so removing it is
    // exact.
    if (!fullRef.startsWith('refs/tags/')) {
      fail(`Expected a tag ref, got "${fullRef}"`);
    }
    const name = fullRef.slice('refs/tags/'.length);
    if (name.length === 0) fail('Tag record is missing a name');

    // `objecttype` is the authority on annotated-or-not, not the presence of a
    // peeled oid: a tag object can in principle point at a tree or a blob, and
    // those have no commit to peel to. Such a tag is still listed — it exists,
    // and a panel that hides refs it does not understand is a panel that lies
    // about what is in the repository — but with the object id standing in for
    // a commit it has none of, so nothing downstream has to handle an empty
    // oid.
    const annotated = type === 'tag';
    tags.push({
      name,
      oid: peeled.length > 0 ? peeled : object,
      object,
      annotated,
      date,
      // Only an annotated tag has a message of its own. `%(contents:subject)`
      // on a lightweight tag returns the *commit's* subject, and a commit
      // message carried in a field called `subject` on a tag is a caption
      // waiting to be printed as something it is not.
      subject: annotated ? subject : '',
    });
  }

  return tags;
}
