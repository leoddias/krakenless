import { beforeEach, describe, expect, it, vi } from 'vitest';
import { userConfirmed } from './confirm';
import { GitError } from './errors';
import { discardHunks } from './stage';
import type { FileDiff, Hunk } from './types';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const BLOB = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const OK = userConfirmed('the user was asked');

function raw(overrides: Record<string, unknown> = {}) {
  return {
    stdout: '',
    stderr: '',
    code: 0,
    timed_out: false,
    stdout_lossy: false,
    ...overrides,
  };
}

const hunk: Hunk = {
  header: '@@ -1,3 +1,3 @@',
  oldStart: 1,
  oldLines: 3,
  newStart: 1,
  newLines: 3,
  lines: [
    { kind: 'context', text: 'a', oldLine: 1, newLine: 1 },
    { kind: 'deleted', text: 'b', oldLine: 2 },
    { kind: 'added', text: 'c', newLine: 2 },
    { kind: 'context', text: 'd', oldLine: 3, newLine: 3 },
  ],
};

function file(overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    oldPath: 'src/a.ts',
    newPath: 'src/a.ts',
    kind: 'modified',
    binary: false,
    conflicted: false,
    side: 'unstaged',
    headerLines: [],
    hunks: [hunk],
    ...overrides,
  };
}

/** The `args` array of each git call, in order. */
function calls(): string[][] {
  return invoke.mock.calls.map((call) => (call[1] as { args: string[] }).args);
}

beforeEach(() => {
  invoke.mockReset();
  // hash-object, then --check, then the real apply.
  invoke
    .mockResolvedValueOnce(raw({ stdout: `${BLOB}\n` }))
    .mockResolvedValue(raw({ stdout: '' }));
});

describe('discardHunks', () => {
  it('backs the file up before it applies anything', () => {
    // Order is the whole safety property. Once the reverse patch lands, these
    // bytes exist nowhere else in the repository.
    return discardHunks('C:/repo', file(), [hunk], OK).then(() => {
      expect(calls()[0]?.[0]).toBe('hash-object');
      expect(calls().findIndex((args) => args.includes('--check'))).toBe(1);
      expect(calls()[2]).not.toContain('--check');
    });
  });

  it('hands back the oid and path, not a shell command', async () => {
    // `git cat-file -p <oid> > path` is byte-exact in cmd.exe and pwsh, but
    // Windows PowerShell 5.1 treats `>` as Out-File and rewrites the stream as
    // UTF-16LE with a BOM. The app does the write itself instead.
    const result = await discardHunks('C:/repo', file(), [hunk], OK);

    expect(result).toEqual({ blobOid: BLOB, path: 'src/a.ts' });
  });

  it('carries no file mode lines, which a partial discard must not revert', async () => {
    // `old mode`/`new mode` describe the *file*, so a reverse apply would chmod
    // it back even though the user picked one hunk — and the content backup
    // cannot restore a mode.
    await discardHunks(
      'C:/repo',
      file({ oldMode: '100644', newMode: '100755' }),
      [hunk],
      OK,
    );

    const patch = invoke.mock.calls
      .map((call) => (call[1] as { stdin?: string }).stdin)
      .find((stdin) => typeof stdin === 'string');
    expect(patch).not.toContain('old mode');
    expect(patch).not.toContain('new mode');
  });

  it('positions the patch by the new side, which is what a reverse apply matches', async () => {
    // Applying to the worktree in reverse means git matches the *new* side, so
    // each hunk's parsed position is already true. Correcting the offsets, as
    // the index path must, would aim it at a line it does not occupy.
    const second: Hunk = {
      ...hunk,
      header: '@@ -46,3 +76,3 @@',
      oldStart: 46,
      newStart: 76,
    };
    await discardHunks('C:/repo', file({ hunks: [hunk, second] }), [second], OK);

    const patch = invoke.mock.calls
      .map((call) => (call[1] as { stdin?: string }).stdin)
      .find((stdin) => typeof stdin === 'string');
    expect(patch).toContain('@@ -46,3 +76,3 @@');
  });

  it('never passes --cached, which would unstage instead of discard', async () => {
    await discardHunks('C:/repo', file(), [hunk], OK);
    for (const args of calls()) expect(args).not.toContain('--cached');
  });

  it.each([
    ['a staged hunk', file({ side: 'staged' }), /unstage this one first/i],
    ['a symlink', file({ newMode: '120000' }), /symlink/i],
    ['a file new to git', file({ kind: 'added' }), /would delete it/i],
    ['a deleted file', file({ kind: 'deleted' }), /already gone/i],
    ['a type change', file({ kind: 'type-changed' }), /changed type/i],
  ])(
    'refuses %s, in the git layer and not only in the UI',
    async (_n, diff, expected) => {
      // Each of these would do something other than "put these lines back": a
      // symlink restore writes through the link onto a file outside the repo,
      // and reverse-applying an added file's patch deletes it from disk.
      await expect(discardHunks('C:/repo', diff, [hunk], OK)).rejects.toThrow(expected);
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it('discards nothing when the backup did not produce an oid', async () => {
    // A backup that silently failed would turn this into an unrecoverable
    // operation, which is exactly the thing the whole design refuses to be.
    invoke.mockReset();
    invoke.mockResolvedValue(raw({ stdout: '\n' }));

    await expect(discardHunks('C:/repo', file(), [hunk], OK)).rejects.toThrow(GitError);
    expect(calls().every((args) => args[0] === 'hash-object')).toBe(true);
  });

  it('stops at the dry run when the selection no longer matches', async () => {
    invoke.mockReset();
    invoke
      .mockResolvedValueOnce(raw({ stdout: `${BLOB}\n` }))
      .mockRejectedValueOnce(new GitError('command-failed', 'patch does not apply'));

    await expect(discardHunks('C:/repo', file(), [hunk], OK)).rejects.toThrow(
      /no longer matches/i,
    );
    // Two calls: the backup and the refused check. The real apply never ran.
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
