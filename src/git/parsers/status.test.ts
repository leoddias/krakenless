import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitError } from '../errors';
import { isDestructive } from '../destructive';
import { buildStatusCommand } from '../commands/status';
import { getStatus } from '../status';
import { parseStatus } from './status';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

/**
 * Every fixture below is verbatim output of git 2.39.2 captured from a
 * disposable repository (`git status --porcelain=v2 --branch -z`, with
 * `core.quotePath=false` as the runner sets it). Records are written one per
 * array element; `nul()` re-adds the terminator git puts after each one,
 * including the last.
 */
function nul(records: string[]): string {
  return records.map((record) => `${record}\0`).join('');
}

const HEAD_OID = 'e3d2d9c1ec7cfeed8c0e326bfe42149f5fdc5078';
const BLOB_A = '587be6b4c3f93f93c489c0111bba5596147a26cb';
const BLOB_B = '5626abf0f72e58d7a153368ba57db4c673c0e171';
const BLOB_C = '19d9cc8584ac2c7dcf57d2680375e80f099dc481';
const BLOB_D = 'cbe236caeb3419c3501a7e131005a2974f840e87';
const ZERO = '0'.repeat(40);

/** A worktree with a deletion, a staged add, a rename, and mixed states. */
const MIXED = [
  `# branch.oid ${HEAD_OID}`,
  '# branch.head main',
  `1 .D N... 100644 100644 000000 ${BLOB_A} ${BLOB_A} acentuação-ü.txt`,
  `1 A. N... 000000 100644 100644 ${ZERO} ${BLOB_D} copied ü.txt`,
  `2 R. N... 100644 100644 100644 ${BLOB_A} ${BLOB_A} R100 renamed name.txt`,
  'oldname.txt',
  `1 .M N... 100644 100644 100644 ${BLOB_B} ${BLOB_B} tracked.txt`,
  `1 MM N... 100644 100644 100644 ${BLOB_A} ${BLOB_C} with space.txt`,
  '? untracked.txt',
];

describe('buildStatusCommand', () => {
  it('emits the exact porcelain v2 argument array', () => {
    expect(buildStatusCommand().args).toEqual([
      '--no-optional-locks',
      'status',
      '--porcelain=v2',
      '--branch',
      '--ahead-behind',
      '-z',
      '--untracked-files=all',
    ]);
  });

  it('does not repeat the runner-level --no-pager / core.quotePath flags', () => {
    const { args } = buildStatusCommand();
    expect(args).not.toContain('--no-pager');
    expect(args).not.toContain('-c');
  });

  it('is not marked destructive, and the arg-level gate agrees', () => {
    expect(buildStatusCommand().destructive).toBeUndefined();
    // The two leading global options must not hide the subcommand from the
    // deny-list, which fails closed on anything it cannot recognize.
    expect(isDestructive(buildStatusCommand().args)).toBe(false);
    expect(isDestructive(buildStatusCommand({ paths: ['a.txt'] }).args)).toBe(false);
  });

  it('takes no index lock and disables pathspec magic', () => {
    // status rewrites the index under .git/index.lock unless told not to, and
    // the runner kills a timed-out git with SIGKILL, which would leave the
    // lock behind. Pathspec magic is disabled by the runner's global
    // --literal-pathspecs (ADR-0015), which stops `:(top)` and friends from
    // widening the report - and later, a discard - to the whole repository.
    const { args } = buildStatusCommand();
    expect(args[0]).toBe('--no-optional-locks');
    expect(args.indexOf('status')).toBe(1);
  });

  it('rejects an untracked mode that did not come from the type system', () => {
    const smuggled = { untracked: 'all --exec=evil' } as unknown as {
      untracked: 'all';
    };
    expect(() => buildStatusCommand(smuggled)).toThrow(GitError);
  });

  it('honours the untracked mode', () => {
    expect(buildStatusCommand({ untracked: 'no' }).args).toContain(
      '--untracked-files=no',
    );
    expect(buildStatusCommand({ untracked: 'normal' }).args).toContain(
      '--untracked-files=normal',
    );
  });

  it('adds --ignored=matching only when asked', () => {
    expect(buildStatusCommand().args).not.toContain('--ignored=matching');
    expect(buildStatusCommand({ includeIgnored: true }).args).toEqual([
      '--no-optional-locks',
      'status',
      '--porcelain=v2',
      '--branch',
      '--ahead-behind',
      '-z',
      '--untracked-files=all',
      '--ignored=matching',
    ]);
  });

  it('rejects the ignored + untracked=no combination git itself refuses', () => {
    // Verified against git 2.39: exit 128, "Unsupported combination of ignored
    // and untracked-files arguments".
    expect(() => buildStatusCommand({ untracked: 'no', includeIgnored: true })).toThrow(
      GitError,
    );
    expect(() =>
      buildStatusCommand({ untracked: 'normal', includeIgnored: true }),
    ).not.toThrow();
  });

  it('puts paths after -- and routes them through the path guard', () => {
    expect(buildStatusCommand({ paths: ['src/a.ts', 'with space.txt'] }).args).toEqual([
      '--no-optional-locks',
      'status',
      '--porcelain=v2',
      '--branch',
      '--ahead-behind',
      '-z',
      '--untracked-files=all',
      '--',
      'src/a.ts',
      'with space.txt',
    ]);
  });

  it('rejects an absolute path instead of reporting on a foreign tree', () => {
    expect(() => buildStatusCommand({ paths: ['C:/Windows/system32'] })).toThrow(
      GitError,
    );
    expect(() => buildStatusCommand({ paths: ['/etc/passwd'] })).toThrow(GitError);
  });

  it('rejects a path that escapes the repository', () => {
    expect(() => buildStatusCommand({ paths: ['../other/secret.txt'] })).toThrow(
      GitError,
    );
  });

  it('rejects an empty path list rather than widening to the whole tree', () => {
    expect(() => buildStatusCommand({ paths: [] })).toThrow(GitError);
  });
});

describe('parseStatus branch headers', () => {
  it('reports an empty repository as head null on a real branch', () => {
    const status = parseStatus(nul(['# branch.oid (initial)', '# branch.head main']));
    expect(status).toEqual({
      branch: 'main',
      head: null,
      detached: false,
      // No `# branch.ab` record without an upstream: the counts stay unknown
      // rather than being invented as zero.
      ahead: undefined,
      behind: undefined,
      entries: [],
      hasConflicts: false,
    });
  });

  it('reports a detached HEAD with no branch name', () => {
    const status = parseStatus(
      nul([`# branch.oid ${HEAD_OID}`, '# branch.head (detached)']),
    );
    expect(status.detached).toBe(true);
    expect(status.branch).toBeNull();
    expect(status.head).toBe(HEAD_OID);
  });

  it('leaves upstream and the counts unknown without a tracking branch', () => {
    const status = parseStatus(nul([`# branch.oid ${HEAD_OID}`, '# branch.head main']));
    expect(status.upstream).toBeUndefined();
    // Unknown, not zero: git prints no `# branch.ab` record here, and a
    // fabricated "0 ahead, 0 behind" reads as "up to date" in the UI.
    expect(status.ahead).toBeUndefined();
    expect(status.behind).toBeUndefined();
  });

  it('parses upstream and a diverged ahead/behind count', () => {
    const status = parseStatus(
      nul([
        '# branch.oid 102facf54ad4f82ce44dced5c4da925f3d7906c2',
        '# branch.head master',
        '# branch.upstream origin/master',
        '# branch.ab +1 -2',
      ]),
    );
    expect(status.upstream).toBe('origin/master');
    expect(status.ahead).toBe(1);
    expect(status.behind).toBe(2);
  });

  it('parses a behind-only branch', () => {
    const status = parseStatus(
      nul([
        '# branch.oid 40fdc71b9015e774a84363ffd9e8e76e314056b6',
        '# branch.head master',
        '# branch.upstream origin/master',
        '# branch.ab +0 -2',
      ]),
    );
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(2);
  });

  it('keeps a branch name that contains a slash intact', () => {
    const status = parseStatus(
      nul([
        `# branch.oid ${HEAD_OID}`,
        '# branch.head feature/status-parser',
        '# branch.upstream origin/feature/status-parser',
      ]),
    );
    expect(status.branch).toBe('feature/status-parser');
    expect(status.upstream).toBe('origin/feature/status-parser');
  });

  it('ignores headers a future git version may add', () => {
    const status = parseStatus(
      nul([`# branch.oid ${HEAD_OID}`, '# branch.head main', '# stash 3']),
    );
    expect(status.entries).toEqual([]);
    expect(status.branch).toBe('main');
  });
});

describe('parseStatus entries', () => {
  it('parses ordinary entries with both sides of the state pair', () => {
    const { entries } = parseStatus(nul(MIXED));
    expect(entries).toHaveLength(6);
    expect(entries[0]).toEqual({
      path: 'acentuação-ü.txt',
      index: 'unmodified',
      worktree: 'deleted',
      conflicted: false,
    });
    expect(entries[1]).toEqual({
      path: 'copied ü.txt',
      index: 'added',
      worktree: 'unmodified',
      conflicted: false,
    });
    expect(entries[4]).toEqual({
      path: 'with space.txt',
      index: 'modified',
      worktree: 'modified',
      conflicted: false,
    });
  });

  it('keeps paths with spaces and non-ASCII characters verbatim', () => {
    const paths = parseStatus(nul(MIXED)).entries.map((entry) => entry.path);
    expect(paths).toContain('acentuação-ü.txt');
    expect(paths).toContain('with space.txt');
    expect(paths).toContain('renamed name.txt');
  });

  it('pairs a rename with its source path and score', () => {
    const renamed = parseStatus(nul(MIXED)).entries[2];
    expect(renamed).toEqual({
      path: 'renamed name.txt',
      origPath: 'oldname.txt',
      index: 'renamed',
      worktree: 'unmodified',
      similarity: 100,
      conflicted: false,
    });
  });

  it('does not let the rename source shift the following entries', () => {
    // The regression this guards: a rename record is two NUL-terminated
    // tokens, so a naive split on NUL makes "oldname.txt" look like the next
    // record and every later path lands on the wrong entry.
    const { entries } = parseStatus(nul(MIXED));
    expect(entries.map((entry) => entry.path)).toEqual([
      'acentuação-ü.txt',
      'copied ü.txt',
      'renamed name.txt',
      'tracked.txt',
      'with space.txt',
      'untracked.txt',
    ]);
    expect(entries.every((entry) => entry.path !== 'oldname.txt')).toBe(true);
  });

  it('parses a copy, whose source also appears as its own entry', () => {
    const blob = '244bbcc4af33fd7d6f99eea67855fcde22bb507c';
    const { entries } = parseStatus(
      nul([
        '# branch.oid 3815de7c65a3d34847a786b654591032410e8e08',
        '# branch.head main',
        `2 C. N... 100644 100644 100644 ${blob} ${blob} C100 dst copy.txt`,
        'src.txt',
        `1 M. N... 100644 100644 100644 ${blob} a8e4d19d7d6b52816e002e7eb861a5d327dbcae3 src.txt`,
      ]),
    );
    expect(entries).toEqual([
      {
        path: 'dst copy.txt',
        origPath: 'src.txt',
        index: 'copied',
        worktree: 'unmodified',
        similarity: 100,
        conflicted: false,
      },
      {
        path: 'src.txt',
        index: 'modified',
        worktree: 'unmodified',
        conflicted: false,
      },
    ]);
  });

  it('parses untracked entries without marking anything as staged', () => {
    const untracked = parseStatus(nul(MIXED)).entries.find(
      (entry) => entry.path === 'untracked.txt',
    );
    // index stays `unmodified`: an untracked file has nothing in the index, so
    // a "staged changes" view must not offer to unstage or commit it.
    expect(untracked).toEqual({
      path: 'untracked.txt',
      index: 'unmodified',
      worktree: 'untracked',
      conflicted: false,
    });
  });

  it('parses ignored entries', () => {
    const { entries } = parseStatus(
      nul([`# branch.oid ${HEAD_OID}`, '# branch.head main', '! ignored.log']),
    );
    expect(entries).toEqual([
      {
        path: 'ignored.log',
        index: 'unmodified',
        worktree: 'ignored',
        conflicted: false,
      },
    ]);
  });

  it('parses unmerged entries and raises hasConflicts', () => {
    const status = parseStatus(
      nul([
        '# branch.oid 60371da7eed8a9f23e20643d266bad6ead41d3cf',
        '# branch.head main',
        `u AA N... 000000 100644 100644 100644 ${ZERO} 5f5e39d13e690ceba0fd915aa7f6f231b8d23498 bd312f52067efdd067cb598060caf9f0afb7a06e added-both.txt`,
        'u UU N... 100644 100644 100644 100644 df967b96a579e45a18b8251732d16804b2e56a55 351be5bf6e17c59ea560546d69654115ecb2fd8d e45c9c2666d44e0327c1f9c239a74c508336053e conflict.txt',
      ]),
    );
    expect(status.hasConflicts).toBe(true);
    expect(status.entries).toEqual([
      {
        path: 'added-both.txt',
        index: 'unmerged',
        worktree: 'unmerged',
        conflicted: true,
        conflictKind: 'AA',
      },
      {
        path: 'conflict.txt',
        index: 'unmerged',
        worktree: 'unmerged',
        conflicted: true,
        conflictKind: 'UU',
      },
    ]);
  });

  it('never reports a delete-side conflict as an ordinary deletion', () => {
    // `u DU` = deleted by us, modified by them; `u UD` = the mirror. Mapping
    // those letters onto index/worktree states would make a conflicted path
    // look like a plain deletion, and a discard action keyed on
    // `worktree !== 'unmodified'` would run checkout against an unmerged index.
    const status = parseStatus(
      nul([
        '# branch.oid 62edacbd90ee015dace0709cd5ee1ca1061a33f6',
        '# branch.head main',
        `u DU N... 100644 000000 100644 100644 df967b96a579e45a18b8251732d16804b2e56a55 ${ZERO} e45c9c2666d44e0327c1f9c239a74c508336053e del-mine.txt`,
        `u UD N... 100644 100644 000000 100644 df967b96a579e45a18b8251732d16804b2e56a55 351be5bf6e17c59ea560546d69654115ecb2fd8d ${ZERO} del-theirs.txt`,
      ]),
    );
    expect(status.hasConflicts).toBe(true);
    for (const entry of status.entries) {
      expect(entry.conflicted).toBe(true);
      expect(entry.index).toBe('unmerged');
      expect(entry.worktree).toBe('unmerged');
    }
    expect(status.entries.map((entry) => entry.path)).toEqual([
      'del-mine.txt',
      'del-theirs.txt',
    ]);
  });

  it('leaves hasConflicts false when no entry is unmerged', () => {
    expect(parseStatus(nul(MIXED)).hasConflicts).toBe(false);
  });

  it('carries the submodule field of a dirty submodule', () => {
    const { entries } = parseStatus(
      nul([
        '# branch.oid 439d89faf0e4cabe470d7a94ce275adf2ca39b2c',
        '# branch.head main',
        `1 A. N... 000000 100644 100644 ${ZERO} 61f904d3facd23a0b86c7b6fce7a3a7f7815ab0b .gitmodules`,
        `1 AM S.MU 000000 160000 160000 ${ZERO} 2504f5a01f1d98f8def3e13552297f4de8fb5252 mysub`,
      ]),
    );
    expect(entries[0]?.submodule).toBeUndefined();
    expect(entries[1]).toEqual({
      path: 'mysub',
      index: 'added',
      worktree: 'modified',
      submodule: 'S.MU',
      conflicted: false,
    });
  });

  it('accepts sha256 object ids', () => {
    const oid = 'a'.repeat(64);
    const { entries } = parseStatus(
      nul([
        `# branch.oid ${'b'.repeat(64)}`,
        '# branch.head main',
        `1 M. N... 100644 100644 100644 ${oid} ${oid} f.txt`,
      ]),
    );
    expect(entries[0]?.path).toBe('f.txt');
  });

  it('keeps a path containing a newline in one entry', () => {
    // Legal on POSIX, and the reason the builder uses -z instead of line mode.
    const { entries } = parseStatus(
      nul([
        `# branch.oid ${HEAD_OID}`,
        '# branch.head main',
        `1 .M N... 100644 100644 100644 ${BLOB_A} ${BLOB_A} two\nlines.txt`,
      ]),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('two\nlines.txt');
  });
});

describe('parseStatus rejects malformed input', () => {
  function expectParseFailure(stdout: string): void {
    let thrown: unknown;
    try {
      parseStatus(stdout);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GitError);
    expect((thrown as GitError).kind).toBe('parse-failed');
  }

  it('refuses output whose last record has no NUL terminator', () => {
    expectParseFailure(
      `${nul([`# branch.oid ${HEAD_OID}`, '# branch.head main'])}? truncated-pa`,
    );
  });

  it('refuses a rename record with no source path after it', () => {
    expectParseFailure(
      nul([`# branch.oid ${HEAD_OID}`, '# branch.head main']) +
        `2 R. N... 100644 100644 100644 ${BLOB_A} ${BLOB_A} R100 new.txt\0`,
    );
  });

  it('refuses an unknown record type', () => {
    expectParseFailure(nul([`# branch.oid ${HEAD_OID}`, '# branch.head main', 'x oops']));
  });

  it('refuses a record whose second character is not a space', () => {
    expectParseFailure(nul([`# branch.oid ${HEAD_OID}`, '# branch.head main', '1oops']));
  });

  it('refuses an ordinary record with a missing field', () => {
    expectParseFailure(
      nul([
        `# branch.oid ${HEAD_OID}`,
        '# branch.head main',
        `1 .M N... 100644 100644 ${BLOB_A} f.txt`,
      ]),
    );
  });

  it('refuses an unknown state letter instead of guessing', () => {
    expectParseFailure(
      nul([
        `# branch.oid ${HEAD_OID}`,
        '# branch.head main',
        `1 ZM N... 100644 100644 100644 ${BLOB_A} ${BLOB_A} f.txt`,
      ]),
    );
  });

  it('refuses a malformed file mode', () => {
    expectParseFailure(
      nul([
        `# branch.oid ${HEAD_OID}`,
        '# branch.head main',
        `1 .M N... 10064 100644 100644 ${BLOB_A} ${BLOB_A} f.txt`,
      ]),
    );
  });

  it('refuses a malformed object id', () => {
    expectParseFailure(
      nul([
        `# branch.oid ${HEAD_OID}`,
        '# branch.head main',
        `1 .M N... 100644 100644 100644 nothexnothexnothexnothexnothexnothexnoth ${BLOB_A} f.txt`,
      ]),
    );
  });

  it('refuses a malformed submodule field', () => {
    expectParseFailure(
      nul([
        `# branch.oid ${HEAD_OID}`,
        '# branch.head main',
        `1 .M X... 100644 100644 100644 ${BLOB_A} ${BLOB_A} f.txt`,
      ]),
    );
  });

  it('refuses a malformed rename score', () => {
    expectParseFailure(
      nul([
        `# branch.oid ${HEAD_OID}`,
        '# branch.head main',
        `2 R. N... 100644 100644 100644 ${BLOB_A} ${BLOB_A} R999 new.txt`,
        'old.txt',
      ]),
    );
  });

  it('refuses an entry with an empty path', () => {
    expectParseFailure(nul([`# branch.oid ${HEAD_OID}`, '# branch.head main', '? ']));
  });

  it('refuses a malformed # branch.ab header', () => {
    expectParseFailure(
      nul([
        `# branch.oid ${HEAD_OID}`,
        '# branch.head main',
        '# branch.upstream origin/main',
        '# branch.ab ahead 1',
      ]),
    );
  });

  it('refuses output without the branch headers', () => {
    expectParseFailure(nul(['? untracked.txt']));
    expectParseFailure(nul([`# branch.oid ${HEAD_OID}`]));
  });

  it('refuses a conflict code git never emits', () => {
    expectParseFailure(
      nul([
        `# branch.oid ${HEAD_OID}`,
        '# branch.head main',
        `u MM N... 100644 100644 100644 100644 ${BLOB_A} ${BLOB_A} ${BLOB_A} f.txt`,
      ]),
    );
  });

  it('keeps failure messages bounded instead of echoing a huge record', () => {
    const longPath = 'a'.repeat(5000);
    let thrown: unknown;
    try {
      parseStatus(
        nul([
          `# branch.oid ${HEAD_OID}`,
          '# branch.head main',
          `1 ZM N... 100644 100644 100644 ${BLOB_A} ${BLOB_A} ${longPath}`,
        ]),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GitError);
    expect((thrown as GitError).message.length).toBeLessThan(400);
  });

  it('attaches no argument list it cannot know', () => {
    let thrown: unknown;
    try {
      parseStatus(nul(['? untracked.txt']));
    } catch (error) {
      thrown = error;
    }
    expect((thrown as GitError).args).toEqual([]);
  });

  it('refuses completely empty output', () => {
    // A repository always reports at least the two branch headers; empty
    // stdout means the command did not run the way we think it did.
    expectParseFailure('');
  });
});

describe('getStatus', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('runs the built command and returns the parsed status', async () => {
    invoke.mockResolvedValue({
      stdout: nul(MIXED),
      stderr: '',
      code: 0,
      timed_out: false,
      stdout_lossy: false,
    });

    const status = await getStatus('C:/repo');

    expect(invoke).toHaveBeenCalledWith('git_run', {
      repo: 'C:/repo',
      stdin: null,
      args: buildStatusCommand().args,
      timeoutMs: null,
    });
    expect(status.branch).toBe('main');
    expect(status.entries.map((entry) => entry.path)).toContain('renamed name.txt');
  });

  it('refuses lossily decoded output instead of parsing invented paths', async () => {
    invoke.mockResolvedValue({
      stdout: nul(MIXED),
      stderr: '',
      code: 0,
      timed_out: false,
      stdout_lossy: true,
    });

    await expect(getStatus('C:/repo')).rejects.toMatchObject({
      kind: 'undecodable-output',
    });
  });

  it('surfaces a failed git run rather than an empty status', async () => {
    invoke.mockResolvedValue({
      stdout: '',
      stderr: 'fatal: not a git repository (or any of the parent directories): .git',
      code: 128,
      timed_out: false,
      stdout_lossy: false,
    });

    await expect(getStatus('C:/nope')).rejects.toMatchObject({
      kind: 'not-a-repository',
    });
  });
});
