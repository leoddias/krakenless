import { describe, expect, it } from 'vitest';
import type { StatusEntry } from '../../git/types';
import {
  conflictDescription,
  discardQuestion,
  displayPath,
  groupEntries,
  pathsOf,
  pathsOfAll,
  recoveryMessage,
  STATE_LABELS,
  STATE_LETTERS,
} from './labels';

function entry(overrides: Partial<StatusEntry> & { path: string }): StatusEntry {
  return {
    index: 'unmodified',
    worktree: 'unmodified',
    conflicted: false,
    ...overrides,
  };
}

describe('groupEntries', () => {
  it('splits by which side of git changed', () => {
    const groups = groupEntries([
      entry({ path: 'staged.ts', index: 'modified' }),
      entry({ path: 'unstaged.ts', worktree: 'modified' }),
    ]);

    expect(groups.staged.map((e) => e.path)).toEqual(['staged.ts']);
    expect(groups.unstaged.map((e) => e.path)).toEqual(['unstaged.ts']);
    expect(groups.conflicted).toEqual([]);
  });

  it('lists a path on both sides when both sides changed', () => {
    const groups = groupEntries([
      entry({ path: 'both.ts', index: 'added', worktree: 'modified' }),
    ]);

    expect(groups.staged.map((e) => e.path)).toEqual(['both.ts']);
    expect(groups.unstaged.map((e) => e.path)).toEqual(['both.ts']);
  });

  it('puts untracked files in the unstaged list', () => {
    const groups = groupEntries([entry({ path: 'new.ts', worktree: 'untracked' })]);

    expect(groups.unstaged.map((e) => e.path)).toEqual(['new.ts']);
    expect(groups.staged).toEqual([]);
  });

  it('drops ignored files from every list', () => {
    const groups = groupEntries([entry({ path: 'dist/app.js', worktree: 'ignored' })]);

    expect(groups).toEqual({ staged: [], unstaged: [], conflicted: [] });
  });

  it('keeps conflicted paths out of the staged and unstaged lists', () => {
    const groups = groupEntries([
      entry({
        path: 'merge.ts',
        index: 'unmerged',
        worktree: 'unmerged',
        conflicted: true,
        conflictKind: 'UU',
      }),
    ]);

    expect(groups.conflicted.map((e) => e.path)).toEqual(['merge.ts']);
    expect(groups.staged).toEqual([]);
    expect(groups.unstaged).toEqual([]);
  });

  it('preserves git order within each list', () => {
    const groups = groupEntries([
      entry({ path: 'b.ts', worktree: 'modified' }),
      entry({ path: 'a.ts', worktree: 'modified' }),
    ]);

    expect(groups.unstaged.map((e) => e.path)).toEqual(['b.ts', 'a.ts']);
  });
});

describe('displayPath', () => {
  it('shows a rename as old → new', () => {
    expect(
      displayPath(entry({ path: 'new.ts', origPath: 'old.ts', index: 'renamed' })),
    ).toBe('old.ts → new.ts');
  });

  it('shows a copy as source → copy', () => {
    expect(
      displayPath(entry({ path: 'copy.ts', origPath: 'orig.ts', index: 'copied' })),
    ).toBe('orig.ts → copy.ts');
  });

  it('shows only the path when there is no rename', () => {
    expect(displayPath(entry({ path: 'a.ts', worktree: 'modified' }))).toBe('a.ts');
  });

  it('ignores an origPath equal to the path', () => {
    expect(displayPath(entry({ path: 'a.ts', origPath: 'a.ts' }))).toBe('a.ts');
  });
});

describe('pathsOf', () => {
  it('names both sides of a rename', () => {
    expect(
      pathsOf(entry({ path: 'new.ts', origPath: 'old.ts', index: 'renamed' })),
    ).toEqual(['old.ts', 'new.ts']);
  });

  it('names one path for everything else', () => {
    expect(pathsOf(entry({ path: 'a.ts', worktree: 'modified' }))).toEqual(['a.ts']);
    expect(pathsOf(entry({ path: 'a.ts', origPath: 'a.ts' }))).toEqual(['a.ts']);
  });

  it('leaves the source of a copy alone', () => {
    // A copy does not change its source, so naming it would stage or discard
    // edits the user never pointed at.
    expect(
      pathsOf(entry({ path: 'copy.ts', origPath: 'orig.ts', index: 'copied' })),
    ).toEqual(['copy.ts']);
  });

  it('collects a list in order and without repeats', () => {
    expect(
      pathsOfAll([
        entry({ path: 'a.ts', worktree: 'modified' }),
        entry({ path: 'a.ts', index: 'modified' }),
        entry({ path: 'new.ts', origPath: 'old.ts', index: 'renamed' }),
      ]),
    ).toEqual(['a.ts', 'old.ts', 'new.ts']);
  });
});

describe('state wording', () => {
  it('maps every file state to the letter git prints', () => {
    expect(STATE_LETTERS).toEqual({
      unmodified: '.',
      modified: 'M',
      added: 'A',
      deleted: 'D',
      renamed: 'R',
      copied: 'C',
      'type-changed': 'T',
      untracked: '?',
      ignored: '!',
      unmerged: 'U',
    });
  });

  it('spells every file state out in English', () => {
    expect(STATE_LABELS).toEqual({
      unmodified: 'Unmodified',
      modified: 'Modified',
      added: 'Added',
      deleted: 'Deleted',
      renamed: 'Renamed',
      copied: 'Copied',
      'type-changed': 'Type changed',
      untracked: 'Untracked',
      ignored: 'Ignored',
      unmerged: 'Conflicted',
    });
  });
});

describe('conflictDescription', () => {
  it('explains each conflict kind', () => {
    expect(conflictDescription('UU')).toBe('Both sides changed this file.');
    expect(conflictDescription('DU')).toBe('Deleted by us, changed by them.');
    expect(conflictDescription('AA')).toBe('Both sides added this file.');
  });

  it('still says something true for a missing kind', () => {
    expect(conflictDescription(undefined)).toBe('This path is unmerged.');
  });
});

describe('discard wording', () => {
  it('names the exact count', () => {
    expect(discardQuestion(['a.ts'])).toBe('Discard changes to 1 file?');
    expect(discardQuestion(['a.ts', 'b.ts'])).toBe('Discard changes to 2 files?');
  });

  it('says the staged version survived, since the discard keeps the index', () => {
    // The exact command is produced by the git layer and rendered beside this
    // text; the wording must not contradict what that command does.
    const text = recoveryMessage();
    expect(text).toContain('stashed');
    expect(text).toContain('staged version');
    expect(text).not.toContain('git stash pop');
  });
});
