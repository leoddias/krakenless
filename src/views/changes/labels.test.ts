import { describe, expect, it } from 'vitest';
import type { FileState, StatusEntry } from '../../git/types';
import {
  conflictDescription,
  discardQuestion,
  displayPath,
  groupEntries,
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

  it('shows only the path when there is no rename', () => {
    expect(displayPath(entry({ path: 'a.ts', worktree: 'modified' }))).toBe('a.ts');
  });

  it('ignores an origPath equal to the path', () => {
    expect(displayPath(entry({ path: 'a.ts', origPath: 'a.ts' }))).toBe('a.ts');
  });
});

describe('state wording', () => {
  const states: FileState[] = [
    'unmodified',
    'modified',
    'added',
    'deleted',
    'renamed',
    'copied',
    'type-changed',
    'untracked',
    'ignored',
    'unmerged',
  ];

  it('has a letter and a label for every file state', () => {
    for (const state of states) {
      expect(STATE_LETTERS[state]).toMatch(/^.$/);
      expect(STATE_LABELS[state].length).toBeGreaterThan(0);
    }
  });

  it('uses git letters for the common states', () => {
    expect(STATE_LETTERS.modified).toBe('M');
    expect(STATE_LETTERS.untracked).toBe('?');
    expect(STATE_LETTERS.unmerged).toBe('U');
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

  it('names the stash and the command that brings the changes back', () => {
    const text = recoveryMessage('krakenless: discarded 2026-08-20T10:00:00.000Z');
    expect(text).toContain('krakenless: discarded 2026-08-20T10:00:00.000Z');
    expect(text).toContain('git stash pop');
  });
});
