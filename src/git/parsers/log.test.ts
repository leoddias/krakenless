import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOG_FIELD_COUNT,
  LOG_FIELD_SEPARATOR,
  LOG_FORMAT,
  LOG_RECORD_SEPARATOR,
  buildLogCommand,
} from '../commands/log';
import { isDestructive } from '../destructive';
import { GitError } from '../errors';
import { readLog } from '../log';
import { parseDecorations, parseLog } from './log';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

/**
 * Every fixture below is verbatim stdout of `git log --decorate=full
 * --format=<LOG_FORMAT>` captured from a throwaway repository built with git
 * 2.39.2, not hand-written: it has a root commit, a merge, a commit with an
 * empty message, a multi-paragraph body, a CRLF body, unicode in the author
 * name and subject, a branch whose name contains a comma, an annotated tag, a
 * remote-tracking ref, a stash ref, and commits whose message really does
 * contain the field/record separators.
 */

/** `git log main --` with HEAD on main: merge, body, empty message, root. */
const HISTORY =
  "\u001e21411ef38d01eb3ca3edb4259f794c4df8eab5ae\u001f21411ef\u001fc7809f0cfffb82d546a128e1de9225876c61f79f 3095bb2422ef76ab06d95a7d8c81a6766eae82d6\u001fÜnicode Ãuthor\u001fu@example.com\u001f2026-08-19T23:27:55-03:00\u001fÜnicode Ãuthor\u001f2026-08-19T23:27:55-03:00\u001fHEAD -> refs/heads/main, tag: refs/tags/annotated, refs/remotes/origin/main, refs/heads/comma,name\u001fMerge branch 'feature'\u001f\n" +
  '\u001ec7809f0cfffb82d546a128e1de9225876c61f79f\u001fc7809f0\u001fae336735e994576907c2702ff1bb87f3cacdb821\u001fÜnicode Ãuthor\u001fu@example.com\u001f2026-08-19T23:27:55-03:00\u001fÜnicode Ãuthor\u001f2026-08-19T23:27:55-03:00\u001f\u001fsubject line\u001fbody line 1\nbody line 2\n\nfinal para\n\n' +
  '\u001e3095bb2422ef76ab06d95a7d8c81a6766eae82d6\u001f3095bb2\u001fc7809f0cfffb82d546a128e1de9225876c61f79f\u001fÜnicode Ãuthor\u001fu@example.com\u001f2026-08-19T23:27:55-03:00\u001fÜnicode Ãuthor\u001f2026-08-19T23:27:55-03:00\u001frefs/heads/feature\u001f\u001f\n' +
  '\u001eae336735e994576907c2702ff1bb87f3cacdb821\u001fae33673\u001f\u001fÜnicode Ãuthor\u001fu@example.com\u001f2026-08-19T23:27:55-03:00\u001fÜnicode Ãuthor\u001f2026-08-19T23:27:55-03:00\u001ftag: refs/tags/v1.0\u001froot commit: café ☕\u001f\n';

/** Same merge commit with HEAD detached on it. */
const DETACHED_HEAD =
  "\u001e21411ef38d01eb3ca3edb4259f794c4df8eab5ae\u001f21411ef\u001fc7809f0cfffb82d546a128e1de9225876c61f79f 3095bb2422ef76ab06d95a7d8c81a6766eae82d6\u001fÜnicode Ãuthor\u001fu@example.com\u001f2026-08-19T23:27:55-03:00\u001fÜnicode Ãuthor\u001f2026-08-19T23:27:55-03:00\u001fHEAD, tag: refs/tags/annotated, refs/remotes/origin/main, refs/heads/main, refs/heads/comma,name\u001fMerge branch 'feature'\u001f\n";

/** A commit created with `--cleanup=verbatim` from a CRLF message file. */
const CRLF_BODY =
  '\u001e3274da1dcfca3dad8048b927d91e95a483bd3459\u001f3274da1\u001f069994c2bb838735f7f4fdcbbab4b7946dcba9b9\u001fÜnicode Ãuthor\u001fu@example.com\u001f2026-08-19T23:28:29-03:00\u001fÜnicode Ãuthor\u001f2026-08-19T23:28:29-03:00\u001f\u001fcrlf subject\u001fline1\r\nline2\r\n\n';

/** The stash commit of `git stash`, decorated with `refs/stash`. */
const STASH_DECORATION =
  '\u001e002fc2dde23669ec9c92b175cdeb4d6b06a5bb78\u001f002fc2d\u001fb49b1d936fb8cb72b429630d68835d1e9a1a0b0c de8e02052c6665911af32ec3ea6092bb1bcc1ff3\u001fÜnicode Ãuthor\u001fu@example.com\u001f2026-08-19T23:29:16-03:00\u001fÜnicode Ãuthor\u001f2026-08-19T23:29:16-03:00\u001frefs/stash\u001fWIP on (no branch): b49b1d9 sep subject\u001f\n';

/** Message body containing a literal field separator (0x1f). */
const FIELD_SEPARATOR_IN_BODY =
  '\u001eddb2ce36ce31d8c0b08bba8fc191fc9b18813f18\u001fddb2ce3\u001f21411ef38d01eb3ca3edb4259f794c4df8eab5ae\u001fÜnicode Ãuthor\u001fu@example.com\u001f2026-08-19T23:34:12-03:00\u001fÜnicode Ãuthor\u001f2026-08-19T23:34:12-03:00\u001fHEAD\u001fus only\u001fbefore\u001fafter\n\n';

/** Message body containing a literal record separator (0x1e). */
const RECORD_SEPARATOR_IN_BODY =
  '\u001e0e6cc70e2cacbd5b60ae63babcf1de5ad9d014c9\u001f0e6cc70\u001fddb2ce36ce31d8c0b08bba8fc191fc9b18813f18\u001fÜnicode Ãuthor\u001fu@example.com\u001f2026-08-19T23:34:12-03:00\u001fÜnicode Ãuthor\u001f2026-08-19T23:34:12-03:00\u001fHEAD\u001frs only\u001fbefore\u001eafter\n\n';

/** Both separators at once, as `git log --all` returned them. */
const BOTH_SEPARATORS_IN_BODY =
  '\u001eb49b1d936fb8cb72b429630d68835d1e9a1a0b0c\u001fb49b1d9\u001f3274da1dcfca3dad8048b927d91e95a483bd3459\u001fÜnicode Ãuthor\u001fu@example.com\u001f2026-08-19T23:28:29-03:00\u001fÜnicode Ãuthor\u001f2026-08-19T23:28:29-03:00\u001f\u001fsep subject\u001fbody\u001fwith US and\u001erecord sep\n\n';

describe('log format constants', () => {
  it('uses ASCII control characters git cannot produce accidentally', () => {
    expect(LOG_FIELD_SEPARATOR).toBe(String.fromCharCode(0x1f));
    expect(LOG_RECORD_SEPARATOR).toBe(String.fromCharCode(0x1e));
  });

  it('starts every record with the record separator and lists free text last', () => {
    expect(LOG_FORMAT.startsWith('%x1e')).toBe(true);
    expect(LOG_FORMAT.split('%x1f')).toHaveLength(LOG_FIELD_COUNT);
    expect(LOG_FORMAT.endsWith('%s%x1f%b')).toBe(true);
  });
});

describe('buildLogCommand', () => {
  it('emits the hardened default invocation', () => {
    expect(buildLogCommand().args).toEqual([
      'log',
      '--no-color',
      '--no-show-signature',
      '--decorate=full',
      `--format=${LOG_FORMAT}`,
      '--',
    ]);
  });

  it('is never treated as a destructive command', () => {
    expect(isDestructive(buildLogCommand({ allRefs: true }).args)).toBe(false);
    expect(buildLogCommand().destructive).toBeUndefined();
  });

  it('adds all-refs, limit, skip and the revision in a stable order', () => {
    expect(
      buildLogCommand({ allRefs: true, limit: 50, skip: 100, rev: 'main..feature' }).args,
    ).toEqual([
      'log',
      '--no-color',
      '--no-show-signature',
      '--decorate=full',
      `--format=${LOG_FORMAT}`,
      '--all',
      '--max-count=50',
      '--skip=100',
      'main..feature',
      '--',
    ]);
  });

  it('allows skipping nothing but not a zero or negative limit', () => {
    expect(buildLogCommand({ skip: 0 }).args).toContain('--skip=0');
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildLogCommand({ limit })).toThrow(GitError);
      expect(() => buildLogCommand({ limit })).toThrow(/limit must be an integer/);
    }
    expect(() => buildLogCommand({ skip: -1 })).toThrow(GitError);
  });

  it('refuses a revision that would become an option', () => {
    // `git branch --all` is a legal branch name; as a bare argument it would
    // silently turn into a flag and widen the walk to every ref.
    for (const rev of ['--all', '-n1', '']) {
      let caught: unknown;
      try {
        buildLogCommand({ rev });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GitError);
      expect((caught as GitError).kind).toBe('bad-argument');
    }
  });
});

describe('parseLog', () => {
  it('parses a real four-commit history field by field', () => {
    expect(parseLog(HISTORY)).toEqual([
      {
        oid: '21411ef38d01eb3ca3edb4259f794c4df8eab5ae',
        shortOid: '21411ef',
        parents: [
          'c7809f0cfffb82d546a128e1de9225876c61f79f',
          '3095bb2422ef76ab06d95a7d8c81a6766eae82d6',
        ],
        authorName: 'Ünicode Ãuthor',
        authorEmail: 'u@example.com',
        authorDate: '2026-08-19T23:27:55-03:00',
        committerName: 'Ünicode Ãuthor',
        committerDate: '2026-08-19T23:27:55-03:00',
        subject: "Merge branch 'feature'",
        body: '',
        refs: [
          { kind: 'head', name: 'HEAD' },
          { kind: 'branch', name: 'main' },
          { kind: 'tag', name: 'annotated' },
          { kind: 'remote-branch', name: 'origin/main' },
          { kind: 'branch', name: 'comma,name' },
        ],
      },
      {
        oid: 'c7809f0cfffb82d546a128e1de9225876c61f79f',
        shortOid: 'c7809f0',
        parents: ['ae336735e994576907c2702ff1bb87f3cacdb821'],
        authorName: 'Ünicode Ãuthor',
        authorEmail: 'u@example.com',
        authorDate: '2026-08-19T23:27:55-03:00',
        committerName: 'Ünicode Ãuthor',
        committerDate: '2026-08-19T23:27:55-03:00',
        subject: 'subject line',
        body: 'body line 1\nbody line 2\n\nfinal para',
        refs: [],
      },
      {
        oid: '3095bb2422ef76ab06d95a7d8c81a6766eae82d6',
        shortOid: '3095bb2',
        parents: ['c7809f0cfffb82d546a128e1de9225876c61f79f'],
        authorName: 'Ünicode Ãuthor',
        authorEmail: 'u@example.com',
        authorDate: '2026-08-19T23:27:55-03:00',
        committerName: 'Ünicode Ãuthor',
        committerDate: '2026-08-19T23:27:55-03:00',
        subject: '',
        body: '',
        refs: [{ kind: 'branch', name: 'feature' }],
      },
      {
        oid: 'ae336735e994576907c2702ff1bb87f3cacdb821',
        shortOid: 'ae33673',
        parents: [],
        authorName: 'Ünicode Ãuthor',
        authorEmail: 'u@example.com',
        authorDate: '2026-08-19T23:27:55-03:00',
        committerName: 'Ünicode Ãuthor',
        committerDate: '2026-08-19T23:27:55-03:00',
        subject: 'root commit: café ☕',
        body: '',
        refs: [{ kind: 'tag', name: 'v1.0' }],
      },
    ]);
  });

  it('gives a root commit no parents and a merge commit two', () => {
    const commits = parseLog(HISTORY);
    expect(commits[0]?.parents).toHaveLength(2);
    expect(commits[3]?.parents).toEqual([]);
  });

  it('keeps interior blank lines and drops only trailing newlines from a body', () => {
    expect(parseLog(HISTORY)[1]?.body).toBe('body line 1\nbody line 2\n\nfinal para');
  });

  it('preserves CRLF inside a body', () => {
    const [commit] = parseLog(CRLF_BODY);
    expect(commit?.subject).toBe('crlf subject');
    expect(commit?.body).toBe('line1\r\nline2');
  });

  it('reads a detached HEAD as a bare HEAD ref', () => {
    expect(parseLog(DETACHED_HEAD)[0]?.refs).toEqual([
      { kind: 'head', name: 'HEAD' },
      { kind: 'tag', name: 'annotated' },
      { kind: 'remote-branch', name: 'origin/main' },
      { kind: 'branch', name: 'main' },
      { kind: 'branch', name: 'comma,name' },
    ]);
  });

  it('drops decorations that have no place in the contract', () => {
    // refs/stash is real output of `git log --all`; the UI has no ref kind for
    // it, and one stash must not make a whole history unparseable.
    expect(parseLog(STASH_DECORATION)[0]?.refs).toEqual([]);
  });

  it('returns nothing for the empty output of a repository without commits', () => {
    expect(parseLog('')).toEqual([]);
    expect(parseLog('\n')).toEqual([]);
  });

  it('rejects a body containing the field separator', () => {
    expect(() => parseLog(FIELD_SEPARATOR_IN_BODY)).toThrow(GitError);
    expect(() => parseLog(FIELD_SEPARATOR_IN_BODY)).toThrow(/Expected 11 fields/);
  });

  it('rejects a body containing the record separator', () => {
    // The tail of the split looks like a second, one-field commit.
    expect(() => parseLog(RECORD_SEPARATOR_IN_BODY)).toThrow(GitError);
  });

  it('rejects a body containing both separators', () => {
    expect(() => parseLog(BOTH_SEPARATORS_IN_BODY)).toThrow(GitError);
  });

  it('reports separator collisions as parse-failed', () => {
    let caught: unknown;
    try {
      parseLog(RECORD_SEPARATOR_IN_BODY);
    } catch (error) {
      caught = error;
    }
    expect((caught as GitError).kind).toBe('parse-failed');
  });

  it('rejects output that does not start with a record separator', () => {
    expect(() => parseLog(`gpg: Signature made Mon\n${HISTORY}`)).toThrow(
      /did not start with the record separator/,
    );
  });

  it('rejects a record whose object name is not an object name', () => {
    const broken = HISTORY.replace('21411ef38d01eb3ca3edb4259f794c4df8eab5ae', 'HEAD');
    expect(() => parseLog(broken)).toThrow(/Unexpected object name/);
  });

  it('rejects a parent that is not an object name', () => {
    const broken = HISTORY.replace('3095bb2422ef76ab06d95a7d8c81a6766eae82d6', 'zzzz');
    expect(() => parseLog(broken)).toThrow(/Unexpected parent object name/);
  });

  it('rejects a record with a missing date', () => {
    const broken = HISTORY.split('2026-08-19T23:27:55-03:00').join('');
    expect(() => parseLog(broken)).toThrow(/without dates/);
  });
});

describe('parseDecorations', () => {
  it('is empty for an undecorated commit', () => {
    expect(parseDecorations('')).toEqual([]);
  });

  it('splits HEAD -> branch into the marker and the branch', () => {
    expect(parseDecorations('HEAD -> refs/heads/main')).toEqual([
      { kind: 'head', name: 'HEAD' },
      { kind: 'branch', name: 'main' },
    ]);
  });

  it('keeps slashes inside branch, tag and remote names', () => {
    expect(
      parseDecorations(
        'refs/heads/feature/log, tag: refs/tags/rel/1.0, refs/remotes/upstream/feature/log',
      ),
    ).toEqual([
      { kind: 'branch', name: 'feature/log' },
      { kind: 'tag', name: 'rel/1.0' },
      { kind: 'remote-branch', name: 'upstream/feature/log' },
    ]);
  });

  it('ignores grafted, replaced and notes decorations', () => {
    expect(parseDecorations('grafted, replaced, refs/notes/commits')).toEqual([]);
  });
});

describe('readLog', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('runs the built command and parses its stdout', async () => {
    invoke.mockResolvedValue({
      stdout: HISTORY,
      stderr: '',
      code: 0,
      timed_out: false,
      stdout_lossy: false,
    });

    const commits = await readLog('C:/repo', { limit: 4 });

    expect(invoke).toHaveBeenCalledWith('git_run', {
      repo: 'C:/repo',
      args: buildLogCommand({ limit: 4 }).args,
      timeoutMs: null,
    });
    expect(commits).toHaveLength(4);
  });

  it('treats an unborn branch as an empty history', async () => {
    invoke.mockResolvedValue({
      stdout: '',
      stderr: "fatal: your current branch 'main' does not have any commits yet",
      code: 128,
      timed_out: false,
      stdout_lossy: false,
    });

    await expect(readLog('C:/repo')).resolves.toEqual([]);
  });

  it('still fails when a requested revision does not exist', async () => {
    invoke.mockResolvedValue({
      stdout: '',
      stderr:
        "fatal: ambiguous argument 'nope': unknown revision or path not in the working tree.",
      code: 128,
      timed_out: false,
      stdout_lossy: false,
    });

    await expect(readLog('C:/repo', { rev: 'nope' })).rejects.toBeInstanceOf(GitError);
  });
});
