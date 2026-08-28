import { describe, expect, it } from 'vitest';
import type { Commit } from '../../git/types';
import type { WorktreeSummary } from '../../git/worktrees';
import {
  applyWorktrees,
  isWorktreeRow,
  worktreeChangeSummary,
  worktreeName,
  worktreeRowOid,
} from './worktreeRows';

function commit(index: number, overrides: Partial<Commit> = {}): Commit {
  const oid = `${index}`.padStart(40, 'a');
  return {
    oid,
    shortOid: oid.slice(0, 7),
    parents: [],
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    authorDate: '2026-08-20T10:00:00+00:00',
    committerName: 'Ada',
    committerDate: '2026-08-20T10:00:00+00:00',
    subject: `Commit ${index}`,
    body: '',
    refs: [],
    ...overrides,
  };
}

function worktree(overrides: Partial<WorktreeSummary> = {}): WorktreeSummary {
  return {
    path: 'C:/repos/app-wiki',
    head: `${1}`.padStart(40, 'a'),
    branch: 'wiki',
    detached: false,
    bare: false,
    locked: null,
    prunable: null,
    main: false,
    changed: 3,
    untracked: 2,
    ...overrides,
  };
}

const ready = (value: WorktreeSummary[]) => ({ state: 'ready' as const, value });

describe('applyWorktrees', () => {
  it('hangs a WIP row above the commit the worktree has checked out', () => {
    const commits = [commit(1), commit(2)];
    const tree = worktree({ head: commits[1]?.oid ?? '' });

    const history = applyWorktrees(commits, ready([tree]));

    expect(history.commits.map((row) => row.oid)).toEqual([
      commits[0]?.oid,
      worktreeRowOid(tree),
      commits[1]?.oid,
    ]);
    expect(history.worktreeRows.get(worktreeRowOid(tree))).toBe(tree);
  });

  it('gives the row that commit as its only parent, so the graph can draw it', () => {
    const commits = [commit(1)];
    const history = applyWorktrees(commits, ready([worktree({ head: commits[0]?.oid })]));
    const row = history.commits[0];

    expect(row?.parents).toEqual([commits[0]?.oid]);
    // No sha, no author, no date of its own: it is not a commit and does not
    // pretend to be one.
    expect(row?.shortOid).toBe('');
    expect(row?.authorName).toBe('');
    expect(row?.authorDate).toBe(commits[0]?.authorDate);
  });

  it('marks the synthetic oid as one nothing may ask git about', () => {
    expect(isWorktreeRow(worktreeRowOid(worktree()))).toBe(true);
    expect(isWorktreeRow('a'.repeat(40))).toBe(false);
  });

  it('leaves the history alone until the worktrees have been read', () => {
    const commits = [commit(1)];
    expect(applyWorktrees(commits, { state: 'loading' }).commits).toBe(commits);
    expect(applyWorktrees(commits, { state: 'idle' }).commits).toBe(commits);
    expect(applyWorktrees(commits, ready([])).commits).toBe(commits);
  });

  it('never draws the checkout you are already looking at', () => {
    const commits = [commit(1)];
    const history = applyWorktrees(
      commits,
      ready([worktree({ head: commits[0]?.oid, main: true })]),
    );
    expect(history.commits).toBe(commits);
  });

  it('skips a worktree with no files to have work in', () => {
    const commits = [commit(1)];
    const head = commits[0]?.oid;
    const history = applyWorktrees(
      commits,
      ready([
        worktree({ head, bare: true }),
        worktree({ head, path: 'C:/gone', prunable: 'gitdir file points to nowhere' }),
        worktree({ head: null, path: 'C:/empty' }),
      ]),
    );
    expect(history.commits).toBe(commits);
  });

  it('drops a worktree whose commit is not on the loaded page', () => {
    // The row has to hang off its commit; a stub pointing at a commit that is
    // not on screen would draw a line into nothing.
    const commits = [commit(1)];
    const history = applyWorktrees(commits, ready([worktree({ head: 'f'.repeat(40) })]));
    expect(history.commits.map((row) => row.oid)).toEqual([commits[0]?.oid]);
    expect(history.worktreeRows.size).toBe(0);
  });

  it('draws two worktrees parked on the same commit as two rows', () => {
    const commits = [commit(1)];
    const head = commits[0]?.oid;
    const history = applyWorktrees(
      commits,
      ready([worktree({ head, path: 'C:/a' }), worktree({ head, path: 'C:/b' })]),
    );
    expect(history.commits).toHaveLength(3);
    expect(history.worktreeRows.size).toBe(2);
  });

  it('still draws a worktree with nothing uncommitted', () => {
    // "Somebody has this branch open, with a clean tree" is worth knowing too.
    const commits = [commit(1)];
    const history = applyWorktrees(
      commits,
      ready([worktree({ head: commits[0]?.oid, changed: 0, untracked: 0 })]),
    );
    expect(history.worktreeRows.size).toBe(1);
  });
});

describe('worktreeName', () => {
  it('is the last path segment, whatever the separators', () => {
    expect(worktreeName(worktree({ path: 'C:/repos/app-wiki' }))).toBe('app-wiki');
    expect(worktreeName(worktree({ path: 'C:\\repos\\app-wiki\\' }))).toBe('app-wiki');
  });
});

describe('worktreeChangeSummary', () => {
  it('counts both kinds of uncommitted work', () => {
    expect(worktreeChangeSummary(worktree({ changed: 3, untracked: 2 }))).toBe(
      '3 changed, 2 new',
    );
    expect(worktreeChangeSummary(worktree({ changed: 3, untracked: 0 }))).toBe(
      '3 changed',
    );
    expect(worktreeChangeSummary(worktree({ changed: 0, untracked: 0 }))).toBe(
      'no uncommitted changes',
    );
  });

  it('says nothing rather than zero when the status could not be read', () => {
    expect(
      worktreeChangeSummary(worktree({ changed: null, untracked: null })),
    ).toBeNull();
  });
});
