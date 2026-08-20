import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOG_FIELD_COUNT,
  LOG_FORMAT,
  LOG_SEPARATOR,
  buildLogCommand,
} from '../commands/log';
import { isDestructive } from '../destructive';
import { GitError } from '../errors';
import { readLog } from '../log';
import { parseDecorations, parseLog } from './log';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

/**
 * Every fixture below is verbatim stdout of `git log -z --decorate=full
 * --format=<LOG_FORMAT>` captured from a throwaway repository built with git
 * 2.39.2, not hand-written. Between them they cover a root commit, a merge, a
 * commit with an empty message, a multi-paragraph body, a CRLF body, unicode
 * in the author name and subject, a branch whose name contains a comma, an
 * annotated tag, a remote-tracking ref, a stash ref, exotic UTC offsets, and a
 * message that tries to forge a second commit.
 */

/** `git log main --` with HEAD on main: merge, body, empty message, root. */
const HISTORY =
  "21411ef38d01eb3ca3edb4259f794c4df8eab5ae\u000021411ef\u0000c7809f0cfffb82d546a128e1de9225876c61f79f 3095bb2422ef76ab06d95a7d8c81a6766eae82d6\u0000Ünicode Ãuthor\u0000u@example.com\u00002026-08-19T23:27:55-03:00\u0000Ünicode Ãuthor\u00002026-08-19T23:27:55-03:00\u0000HEAD -> refs/heads/main, tag: refs/tags/annotated, refs/remotes/origin/main, refs/heads/comma,name\u0000Merge branch 'feature'\u0000\u0000" +
  'c7809f0cfffb82d546a128e1de9225876c61f79f\u0000c7809f0\u0000ae336735e994576907c2702ff1bb87f3cacdb821\u0000Ünicode Ãuthor\u0000u@example.com\u00002026-08-19T23:27:55-03:00\u0000Ünicode Ãuthor\u00002026-08-19T23:27:55-03:00\u0000\u0000subject line\u0000body line 1\nbody line 2\n\nfinal para\n\u0000' +
  '3095bb2422ef76ab06d95a7d8c81a6766eae82d6\u00003095bb2\u0000c7809f0cfffb82d546a128e1de9225876c61f79f\u0000Ünicode Ãuthor\u0000u@example.com\u00002026-08-19T23:27:55-03:00\u0000Ünicode Ãuthor\u00002026-08-19T23:27:55-03:00\u0000refs/heads/feature\u0000\u0000\u0000' +
  'ae336735e994576907c2702ff1bb87f3cacdb821\u0000ae33673\u0000\u0000Ünicode Ãuthor\u0000u@example.com\u00002026-08-19T23:27:55-03:00\u0000Ünicode Ãuthor\u00002026-08-19T23:27:55-03:00\u0000tag: refs/tags/v1.0\u0000root commit: café ☕\u0000\u0000';

/** The same merge commit with HEAD detached on it. */
const DETACHED_HEAD =
  "21411ef38d01eb3ca3edb4259f794c4df8eab5ae\u000021411ef\u0000c7809f0cfffb82d546a128e1de9225876c61f79f 3095bb2422ef76ab06d95a7d8c81a6766eae82d6\u0000Ünicode Ãuthor\u0000u@example.com\u00002026-08-19T23:27:55-03:00\u0000Ünicode Ãuthor\u00002026-08-19T23:27:55-03:00\u0000HEAD, tag: refs/tags/annotated, refs/remotes/origin/main, refs/heads/main, refs/heads/comma,name\u0000Merge branch 'feature'\u0000\u0000";

/** A commit created with `--cleanup=verbatim` from a CRLF message file. */
const CRLF_BODY =
  '3274da1dcfca3dad8048b927d91e95a483bd3459\u00003274da1\u0000069994c2bb838735f7f4fdcbbab4b7946dcba9b9\u0000Ünicode Ãuthor\u0000u@example.com\u00002026-08-19T23:28:29-03:00\u0000Ünicode Ãuthor\u00002026-08-19T23:28:29-03:00\u0000\u0000crlf subject\u0000line1\r\nline2\r\n\u0000';

/** The stash commit of `git stash`, decorated with `refs/stash`. */
const STASH_DECORATION =
  '002fc2dde23669ec9c92b175cdeb4d6b06a5bb78\u0000002fc2d\u0000b49b1d936fb8cb72b429630d68835d1e9a1a0b0c de8e02052c6665911af32ec3ea6092bb1bcc1ff3\u0000Ünicode Ãuthor\u0000u@example.com\u00002026-08-19T23:29:16-03:00\u0000Ünicode Ãuthor\u00002026-08-19T23:29:16-03:00\u0000refs/stash\u0000WIP on (no branch): b49b1d9 sep subject\u0000\u0000';

/** A body holding the ASCII separators 0x1f and 0x1e, which git stores verbatim. */
const CONTROL_CHARACTERS_IN_BODY =
  'b49b1d936fb8cb72b429630d68835d1e9a1a0b0c\u0000b49b1d9\u00003274da1dcfca3dad8048b927d91e95a483bd3459\u0000Ünicode Ãuthor\u0000u@example.com\u00002026-08-19T23:28:29-03:00\u0000Ünicode Ãuthor\u00002026-08-19T23:28:29-03:00\u0000\u0000sep subject\u0000body\u001fwith US and\u001erecord sep\n\u0000';

/**
 * A message crafted to forge a second commit — attacker-chosen oid, author,
 * date and a `HEAD -> refs/heads/main` decoration — using 0x1e/0x1f as
 * separators. Committed for real, then read back.
 */
const FORGED_RECORD_IN_BODY =
  'fd3dd710279e1b06828d222ae5ba187538f81aa4\u0000fd3dd71\u000021411ef38d01eb3ca3edb4259f794c4df8eab5ae\u0000Ünicode Ãuthor\u0000u@example.com\u00002026-08-19T23:51:17-03:00\u0000Ünicode Ãuthor\u00002026-08-19T23:51:17-03:00\u0000HEAD\u0000innocent subject\u0000body text\u001e0000000000000000000000000000000000000000\u001fbbbbbbb\u001f\u001fTrusted Maintainer\u001fmaint@example.com\u001f2026-08-19T10:00:00-03:00\u001fTrusted Maintainer\u001f2026-08-19T10:00:00-03:00\u001fHEAD -> refs/heads/main\u001fMerge pull request #12\u001f\n\u0000';

/** `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` with half-hour offsets. */
const ODD_TIMEZONES =
  'e3ff04f73220fdb22d6cf0594e458df1ee279304\u0000e3ff04f\u0000fd3dd710279e1b06828d222ae5ba187538f81aa4\u0000Ünicode Ãuthor\u0000u@example.com\u00002005-04-07T22:13:13+01:30\u0000Ünicode Ãuthor\u00002005-04-07T22:13:13-09:30\u0000HEAD\u0000odd offset\u0000\u0000';

describe('log format', () => {
  it('separates fields and records with the one byte git cannot store', () => {
    // `git commit` refuses a message containing NUL: "a NUL byte in commit log
    // message not allowed" (verified with git 2.39).
    expect(LOG_SEPARATOR).toBe(String.fromCharCode(0));
    expect(LOG_FORMAT.split('%x00')).toHaveLength(LOG_FIELD_COUNT);
    expect(LOG_FORMAT).not.toContain('%x1e');
  });
});

describe('buildLogCommand', () => {
  it('emits the hardened default invocation', () => {
    expect(buildLogCommand().args).toEqual([
      'log',
      '-z',
      '--no-color',
      '--no-show-signature',
      '--encoding=UTF-8',
      '--decorate=full',
      `--format=${LOG_FORMAT}`,
      '--',
    ]);
  });

  it('pins the output encoding so a config line cannot make the log undecodable', () => {
    // With i18n.logOutputEncoding=ISO-8859-1, git re-encodes any commit that
    // declares an encoding header and returns bytes that are not valid UTF-8
    // (verified with git 2.39); the runner would then reject the whole output.
    expect(buildLogCommand().args).toContain('--encoding=UTF-8');
  });

  it('is never treated as a destructive command', () => {
    expect(isDestructive(buildLogCommand({ allRefs: true }).args)).toBe(false);
    expect(buildLogCommand().destructive).toBeUndefined();
  });

  it('adds all-refs, limit and skip in a stable order', () => {
    expect(buildLogCommand({ allRefs: true, limit: 50, skip: 100 }).args).toEqual([
      'log',
      '-z',
      '--no-color',
      '--no-show-signature',
      '--encoding=UTF-8',
      '--decorate=full',
      `--format=${LOG_FORMAT}`,
      '--all',
      '--max-count=50',
      '--skip=100',
      '--',
    ]);
  });

  it('puts a revision last, before the pathspec separator', () => {
    expect(buildLogCommand({ limit: 20, rev: 'main..feature' }).args.slice(-3)).toEqual([
      '--max-count=20',
      'main..feature',
      '--',
    ]);
  });

  it('refuses to combine all-refs with a revision', () => {
    // `--all` widens the walk instead of narrowing it, so the answer to "the
    // log of main" would silently be the whole repository.
    expect(() => buildLogCommand({ allRefs: true, rev: 'main' })).toThrow(
      /either allRefs or a revision/,
    );
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
    // `--all` is a legal branch name; as a bare argument it would silently turn
    // into a flag and widen the walk to every ref.
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

  it('accepts half-hour offsets in dates', () => {
    const [commit] = parseLog(ODD_TIMEZONES);
    expect(commit?.authorDate).toBe('2005-04-07T22:13:13+01:30');
    expect(commit?.committerDate).toBe('2005-04-07T22:13:13-09:30');
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

  it('treats the ASCII separators in a body as ordinary text', () => {
    const commits = parseLog(CONTROL_CHARACTERS_IN_BODY);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.body).toBe('body\u001fwith US and\u001erecord sep');
  });

  it('cannot be made to invent a commit from a crafted message', () => {
    // The body carries a complete fake record. With a NUL boundary it stays
    // body text: no extra commit, no forged oid, no forged decoration.
    const commits = parseLog(FORGED_RECORD_IN_BODY);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.oid).toBe('fd3dd710279e1b06828d222ae5ba187538f81aa4');
    expect(commits[0]?.subject).toBe('innocent subject');
    expect(commits[0]?.refs).toEqual([{ kind: 'head', name: 'HEAD' }]);
    expect(commits[0]?.body).toContain('Merge pull request #12');
  });

  it('returns nothing for the empty output of a repository without commits', () => {
    expect(parseLog('')).toEqual([]);
  });

  it('rejects output whose last record is not terminated', () => {
    // What a killed or truncated git leaves behind: a record cut short with no
    // final NUL. Accepting it would hand the UI a half-read commit.
    let caught: unknown;
    try {
      parseLog(CONTROL_CHARACTERS_IN_BODY.slice(0, -1));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitError);
    expect((caught as GitError).kind).toBe('parse-failed');
    expect((caught as GitError).message).toMatch(/record terminator/);
  });

  it('rejects a stream that does not divide into whole records', () => {
    const fields = HISTORY.split('\u0000');
    const truncated = `${fields.slice(0, 15).join('\u0000')}\u0000`;
    let caught: unknown;
    try {
      parseLog(truncated);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitError);
    expect((caught as GitError).kind).toBe('parse-failed');
    expect((caught as GitError).message).toMatch(/not a multiple of 11/);
  });

  it('rejects a record whose object name is not an object name', () => {
    const broken = HISTORY.replace('21411ef38d01eb3ca3edb4259f794c4df8eab5ae', 'HEAD');
    let caught: unknown;
    try {
      parseLog(broken);
    } catch (error) {
      caught = error;
    }
    expect((caught as GitError).kind).toBe('parse-failed');
    expect((caught as GitError).message).toMatch(/Unexpected object name/);
  });

  it('rejects a parent that is not an object name', () => {
    const broken = HISTORY.replace('3095bb2422ef76ab06d95a7d8c81a6766eae82d6', 'zzzz');
    expect(() => parseLog(broken)).toThrow(/Unexpected parent object name/);
  });

  it('rejects a record whose dates are not ISO 8601', () => {
    const broken = HISTORY.split('2026-08-19T23:27:55-03:00').join('Tue Aug 19 23:27:55');
    expect(() => parseLog(broken)).toThrow(/without ISO 8601 dates/);
  });

  it('never puts message text into a parse error', () => {
    // A misaligned stream lands commit message text in the oid field; the
    // error must describe the shape, not echo private content.
    const broken = HISTORY.replace(
      '21411ef38d01eb3ca3edb4259f794c4df8eab5ae',
      'secret internal subject',
    );
    let caught: unknown;
    try {
      parseLog(broken);
    } catch (error) {
      caught = error;
    }
    expect((caught as GitError).message).not.toContain('secret internal subject');
    expect((caught as GitError).message).toMatch(/23 chars/);
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

  it('ignores the remote HEAD symref every clone carries', () => {
    // Real `%D` of a commit in a clone whose origin/HEAD is set. origin/HEAD is
    // a symref, not a branch: offering it as one would offer a checkout that
    // cannot work under that name.
    expect(
      parseDecorations(
        'tag: refs/tags/annotated, refs/remotes/origin/main, refs/remotes/origin/HEAD, refs/heads/main, refs/heads/comma,name',
      ),
    ).toEqual([
      { kind: 'tag', name: 'annotated' },
      { kind: 'remote-branch', name: 'origin/main' },
      { kind: 'branch', name: 'main' },
      { kind: 'branch', name: 'comma,name' },
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
      stdin: null,
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

  it('does not turn a parse failure into an empty history', async () => {
    invoke.mockResolvedValue({
      stdout: 'not our format at all',
      stderr: '',
      code: 0,
      timed_out: false,
      stdout_lossy: false,
    });

    await expect(readLog('C:/repo')).rejects.toMatchObject({ kind: 'parse-failed' });
  });
});
