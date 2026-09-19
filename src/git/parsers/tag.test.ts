import { describe, expect, it } from 'vitest';
import { parseTags } from './tag';
import { GitError } from '../errors';

const COMMIT = 'a'.repeat(40);
const TAGOBJ = 'b'.repeat(40);

function record(fields: string[]): string {
  return fields.join('\0');
}

describe('parseTags', () => {
  it('takes the name from the full refname, which git never shortens oddly', () => {
    // With a branch of the same name present, `%(refname:short)` prints
    // `tags/release` — a name `git tag --delete` does not answer to, and one
    // whose restore command would create `refs/tags/tags/release`.
    const stdout = `${record(['refs/tags/release', COMMIT, 'commit', '', '2026-09-19T10:00:00+00:00', ''])}
`;
    expect(parseTags(stdout)[0]?.name).toBe('release');
  });

  it('keeps the slashes inside a tag name', () => {
    const stdout = `${record(['refs/tags/release/1.0', COMMIT, 'commit', '', '2026-09-19T10:00:00+00:00', ''])}
`;
    expect(parseTags(stdout)[0]?.name).toBe('release/1.0');
  });

  it('refuses a record that is not a tag ref at all', () => {
    const stdout = `${record(['refs/heads/main', COMMIT, 'commit', '', '2026-09-19T10:00:00+00:00', ''])}
`;
    expect(() => parseTags(stdout)).toThrow(GitError);
  });

  it('gives a lightweight tag no message: that subject is the commit’s', () => {
    // `%(contents:subject)` falls through to the commit for a lightweight tag,
    // and a commit message in a field called `subject` on a tag is a caption
    // waiting to be printed as something it is not.
    const stdout = `${record(['refs/tags/v1.0', COMMIT, 'commit', '', '2026-09-19T10:00:00+00:00', 'fix the graph'])}
`;
    expect(parseTags(stdout)[0]?.subject).toBe('');
  });

  it('reads a lightweight tag as pointing straight at its commit', () => {
    const stdout = `${record(['refs/tags/v1.0', COMMIT, 'commit', '', '2026-09-19T10:00:00+00:00', ''])}\n`;
    expect(parseTags(stdout)).toEqual([
      {
        name: 'v1.0',
        oid: COMMIT,
        object: COMMIT,
        annotated: false,
        date: '2026-09-19T10:00:00+00:00',
        subject: '',
      },
    ]);
  });

  it('gives an annotated tag the commit it peels to, and keeps the tag object', () => {
    // The distinction the panel depends on: the commit is the row the history
    // has, and the tag object is what a restore has to name to bring the
    // message back with it.
    const stdout = `${record(['refs/tags/v2.0', TAGOBJ, 'tag', COMMIT, '2026-09-19T11:00:00+00:00', 'ship it'])}\n`;
    expect(parseTags(stdout)).toEqual([
      {
        name: 'v2.0',
        oid: COMMIT,
        object: TAGOBJ,
        annotated: true,
        date: '2026-09-19T11:00:00+00:00',
        subject: 'ship it',
      },
    ]);
  });

  it('keeps a tag of something that is not a commit, standing on its own object', () => {
    // A tag of a tree or a blob has nothing to peel to. It exists, so it is
    // listed; hiding refs it does not understand would make the panel lie
    // about what is in the repository.
    const stdout = `${record(['refs/tags/data', TAGOBJ, 'tag', '', '2026-09-19T11:00:00+00:00', 'notes'])}\n`;
    const [tag] = parseTags(stdout);
    expect(tag?.oid).toBe(TAGOBJ);
    expect(tag?.annotated).toBe(true);
  });

  it('reads several tags and keeps git’s order', () => {
    const stdout = [
      record(['refs/tags/v1.10', COMMIT, 'commit', '', '2026-09-19T10:00:00+00:00', '']),
      record(['refs/tags/v1.9', COMMIT, 'commit', '', '2026-09-18T10:00:00+00:00', '']),
      '',
    ].join('\n');
    expect(parseTags(stdout).map((tag) => tag.name)).toEqual(['v1.10', 'v1.9']);
  });

  it('survives CRLF line endings', () => {
    const stdout = `${record(['refs/tags/v1.0', COMMIT, 'commit', '', '2026-09-19T10:00:00+00:00', ''])}\r\n`;
    expect(parseTags(stdout)[0]?.name).toBe('v1.0');
  });

  it('is empty for a repository with no tags', () => {
    expect(parseTags('')).toEqual([]);
    expect(parseTags('\n')).toEqual([]);
  });

  it('keeps a message that contains a newline out of the record boundary', () => {
    // `contents:subject` is one line by construction, but the guard matters:
    // a record with the wrong field count is refused rather than turned into
    // a tag named after half of somebody's message.
    expect(() => parseTags(`${record(['refs/tags/v1.0', COMMIT, 'commit'])}\n`)).toThrow(
      GitError,
    );
  });

  it('refuses a record with no name or no object id', () => {
    expect(() =>
      parseTags(
        `${record(['', COMMIT, 'commit', '', '2026-09-19T10:00:00+00:00', ''])}\n`,
      ),
    ).toThrow(GitError);
    expect(() =>
      parseTags(
        `${record(['refs/tags/v1.0', '', 'commit', '', '2026-09-19T10:00:00+00:00', ''])}\n`,
      ),
    ).toThrow(GitError);
  });
});
