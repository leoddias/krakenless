import { describe, expect, it } from 'vitest';
import type { FileDiff } from '../../git/types';
import { countLines, displayPath, emptyBodyReason } from './labels';

function fileDiff(overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    oldPath: 'src/a.ts',
    newPath: 'src/a.ts',
    kind: 'modified',
    binary: false,
    conflicted: false,
    side: 'unstaged',
    headerLines: ['diff --git a/src/a.ts b/src/a.ts'],
    hunks: [],
    ...overrides,
  };
}

describe('displayPath', () => {
  it('keeps a single path for in-place changes', () => {
    expect(displayPath(fileDiff())).toBe('src/a.ts');
  });

  it('shows both sides for renames and copies', () => {
    expect(
      displayPath(fileDiff({ kind: 'renamed', oldPath: 'a.ts', newPath: 'b.ts' })),
    ).toBe('a.ts → b.ts');
    expect(
      displayPath(fileDiff({ kind: 'copied', oldPath: 'a.ts', newPath: 'c.ts' })),
    ).toBe('a.ts → c.ts');
  });
});

describe('countLines', () => {
  it('counts added and deleted lines across hunks and ignores context and markers', () => {
    const file = fileDiff({
      hunks: [
        {
          header: '@@ -1,2 +1,2 @@',
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 2,
          lines: [
            { kind: 'context', text: 'a', oldLine: 1, newLine: 1 },
            { kind: 'deleted', text: 'b', oldLine: 2 },
            { kind: 'added', text: 'c', newLine: 2 },
          ],
        },
        {
          header: '@@ -9,1 +9,2 @@',
          oldStart: 9,
          oldLines: 1,
          newStart: 9,
          newLines: 2,
          lines: [
            { kind: 'added', text: 'd', newLine: 9 },
            { kind: 'no-newline', text: 'No newline at end of file' },
          ],
        },
      ],
    });
    expect(countLines(file)).toEqual({ added: 2, deleted: 1 });
  });

  it('reports zeroes for a file with no hunks', () => {
    expect(countLines(fileDiff())).toEqual({ added: 0, deleted: 0 });
  });
});

describe('emptyBodyReason', () => {
  it('returns null when there are hunks to render', () => {
    const file = fileDiff({
      hunks: [
        {
          header: '@@ -1 +1 @@',
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [{ kind: 'added', text: 'a', newLine: 1 }],
        },
      ],
    });
    expect(emptyBodyReason(file)).toBeNull();
  });

  it('reports a binary file even when git emitted no hunks', () => {
    expect(emptyBodyReason(fileDiff({ binary: true }))).toMatch(/^Binary file/);
  });

  it('reports a conflicted file before any other reason', () => {
    // A conflicted entry can also look like a plain modification with no hunks;
    // the conflict is the fact the user must see.
    expect(emptyBodyReason(fileDiff({ conflicted: true }))).toMatch(/^Conflicted file/);
  });

  it('prefers the mode-change explanation and names both modes', () => {
    const file = fileDiff({
      headerLines: ['diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755'],
    });
    expect(emptyBodyReason(file)).toBe(
      'File mode changed only — contents are unchanged. 100644 → 100755.',
    );
  });

  it('omits the mode pair when only one side was reported', () => {
    const file = fileDiff({ headerLines: ['diff --git a/x b/x', 'new mode 100755'] });
    expect(emptyBodyReason(file)).toBe(
      'File mode changed only — contents are unchanged.',
    );
  });

  it('explains each hunkless change kind', () => {
    expect(emptyBodyReason(fileDiff({ kind: 'renamed' }))).toMatch(/^Renamed only/);
    expect(emptyBodyReason(fileDiff({ kind: 'copied' }))).toMatch(/^Copied only/);
    expect(emptyBodyReason(fileDiff({ kind: 'added' }))).toMatch(/^New empty file/);
    expect(emptyBodyReason(fileDiff({ kind: 'deleted' }))).toMatch(/^Deleted empty file/);
    expect(emptyBodyReason(fileDiff({ kind: 'type-changed' }))).toMatch(
      /^File type changed/,
    );
    expect(emptyBodyReason(fileDiff({ kind: 'modified' }))).toBe(
      'No textual changes reported for this file.',
    );
  });
});
