import { beforeEach, describe, expect, it, vi } from 'vitest';
import { discardPaths } from './stage';
import { userConfirmed } from './confirm';
import type { RepoStatus, StatusEntry } from './types';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const getStatus = vi.hoisted(() => vi.fn());
vi.mock('./status', () => ({ getStatus }));

function raw(stdout = '', code = 0, stderr = '') {
  return { stdout, stderr, code, timed_out: false, stdout_lossy: false };
}

function entry(path: string, worktree: StatusEntry['worktree']): StatusEntry {
  return { path, index: 'unmodified', worktree, conflicted: false };
}

function status(entries: StatusEntry[]): RepoStatus {
  return {
    branch: 'main',
    head: 'a'.repeat(40),
    detached: false,
    ahead: 0,
    behind: 0,
    entries,
    hasConflicts: false,
  };
}

/** Every git invocation so far. */
function calls(): { args: string[]; stdin: string | null }[] {
  return invoke.mock.calls
    .filter((call) => call[0] === 'git_run')
    .map((call) => call[1] as { args: string[]; stdin: string | null });
}

/** A distinct, well-formed oid per backed-up path. */
function oidFor(index: number): string {
  return String(index + 1).padStart(40, '0');
}

/**
 * A git that answers the way the discard expects: `hash-object` prints one
 * oid per path it was fed, everything else succeeds. `failing` makes that
 * subcommand fail instead.
 */
function mockGit(options: { failing?: string; shortBackup?: boolean } = {}): void {
  invoke.mockImplementation(
    async (_name: string, payload: { args: string[]; stdin: string | null }) => {
      const [first] = payload.args;
      if (first === options.failing) return raw('', 1, `fatal: ${first} refused`);
      if (first === 'hash-object') {
        const paths = (payload.stdin ?? '').split('\n').filter((line) => line.length > 0);
        const count = options.shortBackup === true ? paths.length - 1 : paths.length;
        return raw(
          `${paths
            .slice(0, count)
            .map((_p, i) => oidFor(i))
            .join('\n')}\n`,
        );
      }
      return raw();
    },
  );
}

beforeEach(() => {
  invoke.mockReset();
  getStatus.mockReset();
  mockGit();
});

describe('discardPaths — back up, then remove', () => {
  it('backs every file up in one call before anything is removed, and reports the oids', async () => {
    getStatus.mockResolvedValue(
      status([entry('edited.ts', 'modified'), entry('new.json', 'untracked')]),
    );
    const seen: string[][] = [];

    const result = await discardPaths(
      'C:/repo',
      ['edited.ts', 'new.json'],
      userConfirmed('ok'),
      {
        onBackedUp: (backups) => seen.push(backups.map((backup) => backup.path)),
      },
    );

    const subcommands = calls().map((call) => call.args[0]);
    expect(subcommands).toEqual(['hash-object', 'restore', 'clean']);
    expect(calls()[0]?.args).toEqual([
      'hash-object',
      '-w',
      '--no-filters',
      '--stdin-paths',
    ]);
    expect(calls()[0]?.stdin).toBe('edited.ts\nnew.json\n');
    // The hook saw the records before the restore ran.
    expect(seen).toEqual([['edited.ts', 'new.json']]);
    expect(result).toEqual({
      discarded: true,
      backups: [
        { path: 'edited.ts', blobOid: oidFor(0) },
        { path: 'new.json', blobOid: oidFor(1) },
      ],
      restoredFromIndex: [],
    });
  });

  it('restores tracked files from the index and removes untracked ones with clean', async () => {
    getStatus.mockResolvedValue(
      status([entry('edited.ts', 'modified'), entry('new.json', 'untracked')]),
    );

    await discardPaths('C:/repo', ['edited.ts', 'new.json'], userConfirmed('ok'));

    const restore = calls().find((call) => call.args[0] === 'restore');
    expect(restore?.args).toEqual(['restore', '--worktree', '--', 'edited.ts']);
    const clean = calls().find((call) => call.args[0] === 'clean');
    expect(clean?.args).toEqual(['clean', '--force', '--', 'new.json']);
  });

  it('never creates a stash', async () => {
    // The stash-based discard left an entry in the list and a node on the graph
    // for every click; the blob route is invisible.
    getStatus.mockResolvedValue(status([entry('edited.ts', 'modified')]));

    await discardPaths('C:/repo', ['edited.ts'], userConfirmed('ok'));

    expect(calls().some((call) => call.args[0] === 'stash')).toBe(false);
  });

  it('brings a deleted file back from the index with nothing to back up', async () => {
    getStatus.mockResolvedValue(status([entry('gone.ts', 'deleted')]));

    const result = await discardPaths('C:/repo', ['gone.ts'], userConfirmed('ok'));

    expect(calls().map((call) => call.args[0])).toEqual(['restore']);
    expect(result).toEqual({
      discarded: true,
      backups: [],
      restoredFromIndex: ['gone.ts'],
    });
  });

  it('leaves out a path whose working tree matches the index', async () => {
    // Backing up and "restoring" an unchanged file would claim a discard that
    // changed nothing.
    getStatus.mockResolvedValue(status([entry('staged-only.ts', 'unmodified')]));

    const result = await discardPaths('C:/repo', ['staged-only.ts'], userConfirmed('ok'));

    expect(calls()).toEqual([]);
    expect(result.discarded).toBe(false);
  });

  it('removes nothing when the backup did not cover every file', async () => {
    // One oid short means git did not do what was asked; a discard that went
    // on would be the unrecoverable one this route exists to avoid.
    mockGit({ shortBackup: true });
    getStatus.mockResolvedValue(
      status([entry('a.ts', 'modified'), entry('b.ts', 'modified')]),
    );
    const seen: unknown[] = [];

    await expect(
      discardPaths('C:/repo', ['a.ts', 'b.ts'], userConfirmed('ok'), {
        onBackedUp: (backups) => seen.push(backups),
      }),
    ).rejects.toThrow(/nothing was discarded/);

    expect(seen).toEqual([]);
    expect(calls().map((call) => call.args[0])).toEqual(['hash-object']);
  });

  it('hands the backups over even when the restore then fails', async () => {
    mockGit({ failing: 'restore' });
    getStatus.mockResolvedValue(status([entry('a.ts', 'modified')]));
    const seen: string[][] = [];

    await expect(
      discardPaths('C:/repo', ['a.ts'], userConfirmed('ok'), {
        onBackedUp: (backups) => seen.push(backups.map((backup) => backup.blobOid)),
      }),
    ).rejects.toThrow(/restore refused/);

    expect(seen).toEqual([[oidFor(0)]]);
  });

  it('cleans thousands of untracked files a chunk at a time, after one backup', async () => {
    // `clean` cannot read a long list; `hash-object --stdin-paths` can.
    const many = Array.from({ length: 4524 }, (_, i) => `graphify-out/${String(i)}.json`);
    getStatus.mockResolvedValue(status(many.map((path) => entry(path, 'untracked'))));

    const result = await discardPaths('C:/repo', many, userConfirmed('ok'));

    const backups = calls().filter((call) => call.args[0] === 'hash-object');
    expect(backups).toHaveLength(1);
    expect(backups[0]?.stdin?.split('\n').filter(Boolean)).toHaveLength(4524);
    const cleans = calls().filter((call) => call.args[0] === 'clean');
    expect(cleans.length).toBeGreaterThan(1);
    for (const clean of cleans) {
      expect(clean.args.slice(3).join(' ').length).toBeLessThanOrEqual(8_000);
    }
    expect(cleans.flatMap((clean) => clean.args.slice(3))).toEqual(many);
    expect(result.backups).toHaveLength(4524);
  });

  it('cannot be reached without a confirmation the user minted', async () => {
    await expect(
      // @ts-expect-error — the point of the test: a bare object is not a token.
      discardPaths('C:/repo', ['a.ts'], { reason: '' }),
    ).rejects.toThrow(/onfirmation/);
    expect(calls()).toEqual([]);
  });
});
