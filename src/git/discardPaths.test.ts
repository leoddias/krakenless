import { beforeEach, describe, expect, it, vi } from 'vitest';
import { discardPaths } from './stage';
import { userConfirmed } from './confirm';
import type { RepoStatus, StatusEntry } from './types';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const getStatus = vi.hoisted(() => vi.fn());
vi.mock('./status', () => ({ getStatus }));

const OID = 'b'.repeat(40);

function raw(stdout = '', code = 0, stderr = '') {
  return { stdout, stderr, code, timed_out: false, stdout_lossy: false };
}

function entry(path: string, worktree: StatusEntry['worktree']): StatusEntry {
  return { path, index: 'unmodified', worktree, conflicted: false };
}

function status(entries: StatusEntry[]): RepoStatus {
  return {
    branch: 'main',
    head: OID,
    detached: false,
    ahead: 0,
    behind: 0,
    entries,
    hasConflicts: false,
  };
}

/** Every git invocation so far, as argument arrays. */
function calls(): { args: string[]; stdin: string | null }[] {
  return invoke.mock.calls
    .filter((call) => call[0] === 'git_run')
    .map((call) => call[1] as { args: string[]; stdin: string | null });
}

/** A distinct oid per stash entry, so a second push is visible as new. */
function stashOid(n: number): string {
  return `${OID.slice(0, 36)}${String(n).padStart(4, '0')}`;
}

/**
 * A git that answers the way the discard expects: a stash tip that moves on
 * every push, a tree listing whatever was asked for. `failOnPush` makes that
 * push die the way git does on Windows — with the entry already written.
 */
function mockGit(options: { failOnPush?: number } = {}): void {
  let pushes = 0;
  invoke.mockImplementation(async (_name: string, payload: { args: string[] }) => {
    const [first, second] = payload.args;
    if (first === 'rev-parse' && payload.args.includes('refs/stash')) {
      return pushes > 0 ? raw(`${stashOid(pushes)}\n`) : raw('', 1);
    }
    if (first === 'rev-parse') return raw(`${OID}\n`);
    if (first === 'stash' && second === 'push') {
      pushes += 1;
      if (pushes === options.failOnPush) {
        return raw('', 1, 'error: cannot spawn git: Filename too long\n');
      }
      return raw('Saved working directory\n');
    }
    if (first === 'ls-tree') {
      return raw(payload.args.slice(payload.args.indexOf('--') + 1).join('\0'));
    }
    return raw();
  });
}

beforeEach(() => {
  invoke.mockReset();
  getStatus.mockReset();
  mockGit();
});

describe('discardPaths — planning what to stash', () => {
  it('sorts the paths with one status read, never a pathspec on the command line', async () => {
    // `ls-files` and `diff` over the requested paths were the previous plan.
    // Neither accepts a pathspec on stdin, so a few thousand untracked files
    // made a command line Windows would not start a process with.
    getStatus.mockResolvedValue(
      status([
        entry('edited.ts', 'modified'),
        entry('new.json', 'untracked'),
        entry('staged-only.ts', 'unmodified'),
      ]),
    );

    await discardPaths(
      'C:/repo',
      ['edited.ts', 'new.json', 'staged-only.ts'],
      userConfirmed('Discard changes to 3 files?'),
    );

    expect(getStatus).toHaveBeenCalledWith('C:/repo');
    const subcommands = calls().map((call) => call.args[0]);
    expect(subcommands).not.toContain('ls-files');
    expect(subcommands).not.toContain('diff');
  });

  it('stashes the tracked edit with --keep-index and the untracked file without', async () => {
    getStatus.mockResolvedValue(
      status([entry('edited.ts', 'modified'), entry('new.json', 'untracked')]),
    );

    await discardPaths('C:/repo', ['edited.ts', 'new.json'], userConfirmed('ok'));

    const pushes = calls().filter((call) => call.args[0] === 'stash');
    expect(pushes).toHaveLength(2);
    expect(pushes[0]?.args).toEqual(
      expect.arrayContaining(['--keep-index', '--', 'edited.ts']),
    );
    expect(pushes[0]?.args).not.toContain('new.json');
    expect(pushes[1]?.args).toEqual(
      expect.arrayContaining(['--include-untracked', '--', 'new.json']),
    );
    expect(pushes[1]?.args).not.toContain('--keep-index');
  });

  it('leaves out a path whose working tree matches the index', async () => {
    // Stashing it would create an entry and change nothing, and the user
    // would be told their changes were discarded while the file sits there.
    getStatus.mockResolvedValue(status([entry('staged-only.ts', 'unmodified')]));

    const result = await discardPaths('C:/repo', ['staged-only.ts'], userConfirmed('ok'));

    expect(calls().some((call) => call.args[0] === 'stash')).toBe(false);
    expect(result.discarded).toBe(false);
  });
});

describe('discardPaths — thousands of files', () => {
  const many = Array.from({ length: 4524 }, (_, i) => `graphify-out/${String(i)}.json`);

  beforeEach(() => {
    getStatus.mockResolvedValue(status(many.map((path) => entry(path, 'untracked'))));
  });

  it('stashes them a chunk at a time, one route back per chunk', async () => {
    // `git stash push` cannot take a long list by any route — it hands the
    // paths to the `git clean` it spawns as arguments — so the phase is split
    // into pushes that each fit git's own command line.
    const result = await discardPaths('C:/repo', many, userConfirmed('ok'));

    const pushes = calls().filter((call) => call.args[0] === 'stash');
    expect(pushes.length).toBeGreaterThan(1);
    for (const push of pushes) {
      expect(push.stdin).toBeNull();
      const listed = push.args.slice(push.args.indexOf('--') + 1);
      expect(listed.join(' ').length).toBeLessThanOrEqual(8_000);
    }
    // Every path, once, in order — and every push named as a part.
    const pushed = pushes.flatMap((push) => push.args.slice(push.args.indexOf('--') + 1));
    expect(pushed).toEqual(many);
    const labels = pushes.map((push) => push.args[push.args.indexOf('--message') + 1]);
    expect(labels[0]).toMatch(/\(1\/\d+\)$/);
    expect(new Set(labels).size).toBe(pushes.length);

    expect(result.discarded).toBe(true);
    expect(result.undoCommands).toHaveLength(pushes.length);
  });

  it('keeps the routes back that earlier chunks earned when a later one fails', async () => {
    mockGit({ failOnPush: 2 });

    await expect(discardPaths('C:/repo', many, userConfirmed('ok'))).rejects.toThrow(
      // The failure in git's words, and one route per entry that exists: the
      // first push's, and the second's, whose entry was written before it died.
      /failed partway.*Filename too long.*Recover with: .*Recover with: /s,
    );
  });
});
