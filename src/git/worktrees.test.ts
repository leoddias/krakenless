import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoStatus, StatusEntry } from './types';
import {
  countChanges,
  listWorktreeSummaries,
  listWorktrees,
  samePath,
} from './worktrees';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const MAIN = 'C:/repos/app';
const WIKI = 'C:/repos/app-wiki';
const OID = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

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

const LIST =
  `worktree ${MAIN}\nHEAD ${OID}\nbranch refs/heads/main\n\n` +
  `worktree ${WIKI}\nHEAD ${OID}\nbranch refs/heads/wiki\n\n`;

/**
 * Porcelain v2 status: one changed file and one untracked file. Records are
 * NUL-terminated because the status command asks for `-z`, which is what makes
 * a path containing a newline parseable.
 */
const STATUS =
  `# branch.oid ${OID}\0# branch.head main\0` +
  `1 .M N... 100644 100644 100644 ${OID} ${OID} src/app.ts\0? notes.md\0`;

/** The repo path each git invocation was made in, in call order. */
function repoOf(call: number): string {
  return invoke.mock.calls[call]?.[1].repo as string;
}

beforeEach(() => {
  invoke.mockReset();
});

describe('listWorktrees', () => {
  it('asks git for the porcelain list and parses it', async () => {
    invoke.mockResolvedValue(raw({ stdout: LIST }));
    const worktrees = await listWorktrees(MAIN);

    expect(invoke.mock.calls[0]?.[1].args).toEqual(['worktree', 'list', '--porcelain']);
    expect(worktrees.map((tree) => tree.path)).toEqual([MAIN, WIKI]);
  });
});

describe('countChanges', () => {
  function status(entries: Partial<StatusEntry>[]): RepoStatus {
    return {
      branch: 'main',
      head: OID,
      detached: false,
      hasConflicts: false,
      entries: entries.map((entry) => ({
        path: 'x',
        index: 'unmodified',
        worktree: 'unmodified',
        conflicted: false,
        ...entry,
      })) as StatusEntry[],
    };
  }

  it('counts changed files apart from untracked ones', () => {
    expect(
      countChanges(
        status([
          { index: 'modified' },
          { worktree: 'modified' },
          { index: 'untracked', worktree: 'untracked' },
        ]),
      ),
    ).toEqual({ changed: 2, untracked: 1 });
  });

  it('does not count ignored files as work', () => {
    expect(countChanges(status([{ index: 'ignored', worktree: 'ignored' }]))).toEqual({
      changed: 0,
      untracked: 0,
    });
  });

  it('counts a conflicted path once, as changed', () => {
    expect(
      countChanges(
        status([{ index: 'modified', worktree: 'modified', conflicted: true }]),
      ),
    ).toEqual({ changed: 1, untracked: 0 });
  });
});

describe('listWorktreeSummaries', () => {
  it('reads each linked worktree\u2019s status in that worktree', async () => {
    invoke
      .mockResolvedValueOnce(raw({ stdout: LIST }))
      .mockResolvedValueOnce(raw({ stdout: STATUS }))
      .mockResolvedValueOnce(raw({ stdout: STATUS }));

    const summaries = await listWorktreeSummaries(MAIN);

    // `git status` run *in* the worktree: it resolves the shared `.git` from
    // wherever it is invoked, and asking from here would answer about here.
    expect(repoOf(1)).toBe(MAIN);
    expect(repoOf(2)).toBe(WIKI);
    expect(summaries.map((tree) => tree.changed)).toEqual([1, 1]);
    expect(summaries.map((tree) => tree.untracked)).toEqual([1, 1]);
  });

  it('skips the worktree the app is standing in', async () => {
    invoke
      .mockResolvedValueOnce(raw({ stdout: LIST }))
      .mockResolvedValueOnce(raw({ stdout: STATUS }));

    const summaries = await listWorktreeSummaries(MAIN, { skip: 'c:\\repos\\app\\' });

    // Same directory, other separators and case: the tab list compares paths
    // this way too, so the two cannot disagree about what "here" is.
    expect(summaries[0]).toMatchObject({ path: MAIN, changed: null, untracked: null });
    expect(summaries[1]?.changed).toBe(1);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('still lists a worktree whose status cannot be read', async () => {
    invoke
      .mockResolvedValueOnce(raw({ stdout: LIST }))
      .mockResolvedValueOnce(raw({ stdout: STATUS }))
      .mockRejectedValueOnce(new Error('The system cannot find the path specified'));

    const summaries = await listWorktreeSummaries(MAIN);

    // A deleted directory or a disconnected drive is not a reason to lose the
    // list, and a zero there would be a confident lie about a checkout.
    expect(summaries[1]).toMatchObject({ path: WIKI, changed: null, untracked: null });
  });

  it('never runs status against a bare or prunable worktree', async () => {
    invoke.mockResolvedValueOnce(
      raw({
        stdout:
          `worktree C:/repos/app.git\nbare\n\n` +
          `worktree C:/gone\nHEAD ${OID}\ndetached\nprunable gitdir file points to non-existent location\n\n`,
      }),
    );

    const summaries = await listWorktreeSummaries(MAIN);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(summaries.every((tree) => tree.changed === null)).toBe(true);
  });
});

describe('samePath', () => {
  it('treats separators and case as noise, the way the tab list does', () => {
    expect(samePath('C:/repos/app', 'c:\\repos\\App')).toBe(true);
    expect(samePath('C:/repos/app/', 'C:/repos/app')).toBe(true);
    expect(samePath('C:/repos/app', 'C:/repos/app-wiki')).toBe(false);
  });
});
