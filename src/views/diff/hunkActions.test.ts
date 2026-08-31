import { describe, expect, it } from 'vitest';
import type { FileDiff } from '../../git/types';
import { discardHunkQuestion, hunkActionBlocker, hunkActions } from './hunkActions';

function file(overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    oldPath: 'src/a.ts',
    newPath: 'src/a.ts',
    kind: 'modified',
    binary: false,
    conflicted: false,
    side: 'unstaged',
    headerLines: [],
    hunks: [],
    ...overrides,
  };
}

function labels(diff: FileDiff): string[] {
  return hunkActions(diff).map((spec) => spec.label);
}

describe('hunkActions', () => {
  it('offers staging and discarding on the unstaged side', () => {
    expect(labels(file())).toEqual(['Discard Hunk', 'Stage Hunk']);
  });

  it('offers only unstaging on the staged side', () => {
    // The direction is read from the side, never guessed. Both entries for one
    // path can be on screen at once, and a button that assumed "unstaged"
    // would stage a hunk the user asked to take back out.
    expect(labels(file({ side: 'staged' }))).toEqual(['Unstage Hunk']);
  });

  it('does not offer to discard a staged hunk', () => {
    // "Discard" there could mean drop it from the index or from both, and the
    // user cannot tell which they are getting. Unstage first, then decide.
    expect(labels(file({ side: 'staged' }))).not.toContain('Discard Hunk');
  });

  it('offers nothing on a commit, which has nothing to move', () => {
    expect(hunkActions(file({ side: 'commit' }))).toEqual([]);
  });

  it.each([
    ['added', file({ kind: 'added' })],
    ['deleted', file({ kind: 'deleted' })],
    ['type-changed', file({ kind: 'type-changed' })],
  ])('offers staging but not discarding for a %s file', (_name, diff) => {
    // Reverse-applying an added file's patch *deletes* it, which is not what
    // "put these lines back" describes. Staging the same hunk is still fine.
    expect(labels(diff)).toEqual(['Stage Hunk']);
  });

  it('marks exactly one action as destructive', () => {
    const danger = hunkActions(file()).filter((spec) => spec.danger);
    expect(danger.map((spec) => spec.action)).toEqual(['discard']);
  });
});

describe('hunkActionBlocker', () => {
  it('passes an ordinary modified file', () => {
    expect(hunkActionBlocker(file())).toBeNull();
  });

  it.each([
    ['binary', file({ binary: true }), /binary/i],
    ['conflicted', file({ conflicted: true }), /resolve this conflict/i],
    ['renamed', file({ kind: 'renamed' }), /renamed/i],
    ['copied', file({ kind: 'copied' }), /copied/i],
    ['symlink', file({ newMode: '120000' }), /symlink/i],
  ])('refuses a %s file and says why', (_name, diff, expected) => {
    // Every one of these is a shape `serializeHunks` throws on. A button that
    // could only ever fail teaches the user the feature is broken; for a
    // rename, one that *worked* would record the content without the rename.
    expect(hunkActionBlocker(diff)).toMatch(expected);
    expect(hunkActions(diff)).toEqual([]);
  });
});

describe('discardHunkQuestion', () => {
  it('names the file, quotes the hunk, and promises the way back', () => {
    const question = discardHunkQuestion('src/a.ts', '@@ -1,3 +1,3 @@');
    expect(question).toContain('src/a.ts');
    expect(question).toContain('@@ -1,3 +1,3 @@');
    expect(question).toMatch(/undo this from Recent discards/);
  });
});
