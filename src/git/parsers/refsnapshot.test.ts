import { describe, expect, it } from 'vitest';
import { buildRefSnapshotCommand } from '../commands/refsnapshot';
import { parseRefSnapshot } from './refsnapshot';

describe('buildRefSnapshotCommand', () => {
  it('asks only for the refs a fetch can move, oid first', () => {
    expect(buildRefSnapshotCommand().args).toEqual([
      'for-each-ref',
      '--format=%(objectname) %(refname)',
      'refs/remotes',
      'refs/tags',
    ]);
  });

  it('is not a destructive command', () => {
    expect(buildRefSnapshotCommand().destructive).toBeFalsy();
  });
});

describe('parseRefSnapshot', () => {
  it('reads every ref as name to oid', () => {
    const snapshot = parseRefSnapshot(
      [
        '1111111111111111111111111111111111111111 refs/remotes/origin/main',
        '2222222222222222222222222222222222222222 refs/tags/v1.0',
        '',
      ].join('\n'),
    );

    expect([...snapshot]).toEqual([
      ['refs/remotes/origin/main', '1111111111111111111111111111111111111111'],
      ['refs/tags/v1.0', '2222222222222222222222222222222222222222'],
    ]);
  });

  it('tolerates CRLF, which is what git writes on Windows through a pipe', () => {
    const snapshot = parseRefSnapshot(
      '1111111111111111111111111111111111111111 refs/tags/v1.0\r\n',
    );
    expect(snapshot.get('refs/tags/v1.0')).toBe(
      '1111111111111111111111111111111111111111',
    );
  });

  it('drops refs/remotes/<remote>/HEAD, which only echoes another branch', () => {
    const snapshot = parseRefSnapshot(
      [
        '1111111111111111111111111111111111111111 refs/remotes/origin/HEAD',
        '1111111111111111111111111111111111111111 refs/remotes/origin/main',
      ].join('\n'),
    );
    expect([...snapshot.keys()]).toEqual(['refs/remotes/origin/main']);
  });

  it('keeps a branch whose name merely ends in HEAD', () => {
    const snapshot = parseRefSnapshot(
      '1111111111111111111111111111111111111111 refs/remotes/origin/fix-HEAD',
    );
    expect(snapshot.has('refs/remotes/origin/fix-HEAD')).toBe(true);
  });

  it('skips lines it cannot read rather than throwing', () => {
    // A snapshot exists to compare two moments. Failing on one odd line would
    // turn "I could not tell what changed" into "the fetch failed".
    const snapshot = parseRefSnapshot(
      [
        'garbage-with-no-space',
        ' refs/tags/leading-space-has-no-oid',
        '3333333333333333333333333333333333333333 refs/tags/good',
      ].join('\n'),
    );
    expect([...snapshot.keys()]).toEqual(['refs/tags/good']);
  });

  it('is empty for a repository with no remote refs at all', () => {
    expect(parseRefSnapshot('').size).toBe(0);
  });
});
