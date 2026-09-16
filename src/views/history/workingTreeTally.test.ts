import { describe, expect, it } from 'vitest';
import type { RepoStatus, StatusEntry } from '../../git/types';
import {
  isClean,
  tallyParts,
  tallySentence,
  tallyTracked,
  tallyWorkingTree,
} from './workingTreeTally';

function entry(overrides: Partial<StatusEntry>): StatusEntry {
  return {
    path: 'a.txt',
    index: 'unmodified',
    worktree: 'unmodified',
    conflicted: false,
    ...overrides,
  };
}

function status(entries: StatusEntry[]): RepoStatus {
  return {
    branch: 'main',
    head: 'a'.repeat(40),
    detached: false,
    entries,
    hasConflicts: false,
  };
}

describe('tallyWorkingTree', () => {
  it('counts nothing when there is no status yet', () => {
    expect(tallyWorkingTree(null)).toEqual({ added: 0, modified: 0, deleted: 0 });
  });

  it('counts a path once even though it has two sides', () => {
    // The whole point of the module: a file edited and staged is one change,
    // not one in the index plus one on disk.
    const tally = tallyWorkingTree(
      status([entry({ index: 'modified', worktree: 'modified' })]),
    );
    expect(tally).toEqual({ added: 0, modified: 1, deleted: 0 });
  });

  it('counts untracked files as additions', () => {
    const tally = tallyWorkingTree(
      status([entry({ index: 'untracked', worktree: 'untracked' })]),
    );
    expect(tally.added).toBe(1);
  });

  it('counts a staged addition as an addition', () => {
    expect(tallyWorkingTree(status([entry({ index: 'added' })])).added).toBe(1);
  });

  it('lets the working tree decide when the two sides disagree', () => {
    // Staged as added, then deleted from disk. What the user would see if they
    // looked is that the file is gone.
    const tally = tallyWorkingTree(
      status([entry({ index: 'added', worktree: 'deleted' })]),
    );
    expect(tally).toEqual({ added: 0, modified: 0, deleted: 1 });
  });

  it('falls back to the index when the working tree is unmodified', () => {
    const tally = tallyWorkingTree(
      status([entry({ index: 'deleted', worktree: 'unmodified' })]),
    );
    expect(tally.deleted).toBe(1);
  });

  it('counts a rename once, as a modification', () => {
    // One person moved one file. Reporting +1 and -1 would double a refactor.
    const tally = tallyWorkingTree(
      status([entry({ index: 'renamed', origPath: 'old.txt' })]),
    );
    expect(tally).toEqual({ added: 0, modified: 1, deleted: 0 });
  });

  it('ignores ignored files', () => {
    const tally = tallyWorkingTree(
      status([entry({ index: 'ignored', worktree: 'ignored' })]),
    );
    expect(isClean(tally)).toBe(true);
  });

  it('counts a conflicted path as modified', () => {
    const tally = tallyWorkingTree(
      status([entry({ index: 'unmerged', worktree: 'unmerged', conflicted: true })]),
    );
    expect(tally.modified).toBe(1);
  });

  it('adds up a realistic mixture', () => {
    const tally = tallyWorkingTree(
      status([
        entry({ path: 'new1', index: 'untracked', worktree: 'untracked' }),
        entry({ path: 'new2', index: 'added' }),
        entry({ path: 'edit1', worktree: 'modified' }),
        entry({ path: 'edit2', index: 'modified', worktree: 'modified' }),
        entry({ path: 'edit3', worktree: 'type-changed' }),
        entry({ path: 'gone', worktree: 'deleted' }),
        entry({ path: 'build/out', index: 'ignored', worktree: 'ignored' }),
      ]),
    );
    expect(tally).toEqual({ added: 2, modified: 3, deleted: 1 });
  });
});

describe('how the counts are drawn', () => {
  it('writes them the way the row shows them', () => {
    expect(tallyParts({ added: 15, modified: 1, deleted: 2 }).map((p) => p.text)).toEqual(
      ['+15', 'M1', '-2'],
    );
  });

  it('leaves out a zero instead of printing it', () => {
    expect(tallyParts({ added: 0, modified: 3, deleted: 0 }).map((p) => p.text)).toEqual([
      'M3',
    ]);
    expect(tallyParts({ added: 0, modified: 0, deleted: 0 })).toEqual([]);
  });

  it('says the same thing in words for a screen reader', () => {
    expect(tallySentence({ added: 15, modified: 1, deleted: 2 })).toBe(
      '15 added, 1 modified, 2 deleted',
    );
    expect(tallySentence({ added: 0, modified: 0, deleted: 0 })).toBe(
      'no uncommitted changes',
    );
  });

  it('knows a clean tree from a dirty one', () => {
    expect(isClean({ added: 0, modified: 0, deleted: 0 })).toBe(true);
    expect(isClean({ added: 0, modified: 0, deleted: 1 })).toBe(false);
  });
});

describe('tallyTracked', () => {
  it('leaves untracked files out, because a stash would not move them', () => {
    // The row is right to show `+3` for three new files; a stash offered on
    // that basis would print "No local changes to save", exit 0, and do
    // nothing while the confirmation promised three files would move.
    const only = status([
      entry({ path: 'n1', index: 'untracked', worktree: 'untracked' }),
      entry({ path: 'n2', index: 'untracked', worktree: 'untracked' }),
    ]);
    expect(isClean(tallyWorkingTree(only))).toBe(false);
    expect(isClean(tallyTracked(only))).toBe(true);
  });

  it('counts the tracked ones the same way the row does', () => {
    const mixed = status([
      entry({ path: 'n1', index: 'untracked', worktree: 'untracked' }),
      entry({ path: 'a1', index: 'added' }),
      entry({ path: 'e1', worktree: 'modified' }),
      entry({ path: 'g1', worktree: 'deleted' }),
      entry({ path: 'ign', index: 'ignored', worktree: 'ignored' }),
    ]);
    expect(tallyTracked(mixed)).toEqual({ added: 1, modified: 1, deleted: 1 });
    expect(tallyWorkingTree(mixed)).toEqual({ added: 2, modified: 1, deleted: 1 });
  });

  it('counts nothing without a status', () => {
    expect(isClean(tallyTracked(null))).toBe(true);
  });
});
