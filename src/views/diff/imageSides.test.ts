import { describe, expect, it } from 'vitest';
import type { FileDiff } from '../../git/types';
import { displayScale, formatBytes, imageMime, imageSides } from './imageSides';

const OID = 'b'.repeat(40);

function file(overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    oldPath: 'img/a.png',
    newPath: 'img/a.png',
    kind: 'modified',
    binary: true,
    conflicted: false,
    side: 'commit',
    headerLines: [],
    hunks: [],
    ...overrides,
  };
}

describe('imageMime', () => {
  it('knows the raster formats, ignoring case', () => {
    expect(imageMime('a.png')).toBe('image/png');
    expect(imageMime('dir/b.JPG')).toBe('image/jpeg');
    expect(imageMime('c.webp')).toBe('image/webp');
  });

  it('previews no SVG, no extensionless file, and no dot in a folder name', () => {
    expect(imageMime('logo.svg')).toBeNull();
    expect(imageMime('Makefile')).toBeNull();
    expect(imageMime('assets.png/readme')).toBeNull();
    expect(imageMime('data.bin')).toBeNull();
  });
});

describe('imageSides', () => {
  it('pairs a commit with its first parent', () => {
    expect(imageSides(file(), OID)).toEqual({
      before: {
        from: 'blob',
        source: { kind: 'commit', oid: OID, parent: true },
        path: 'img/a.png',
      },
      after: { from: 'blob', source: { kind: 'commit', oid: OID }, path: 'img/a.png' },
    });
  });

  it('has no before for an added file and no after for a deleted one', () => {
    expect(imageSides(file({ kind: 'added' }), OID)?.before).toBeNull();
    expect(imageSides(file({ kind: 'deleted' }), OID)?.after).toBeNull();
    expect(imageSides(file({ kind: 'deleted' }), OID)?.before).not.toBeNull();
  });

  it('reads the old name before a rename and the new one after', () => {
    const sides = imageSides(
      file({ kind: 'renamed', oldPath: 'old/a.png', newPath: 'new/b.png' }),
      OID,
    );
    expect(sides?.before).toMatchObject({ path: 'old/a.png' });
    expect(sides?.after).toMatchObject({ path: 'new/b.png' });
  });

  it('compares staged work against HEAD, and the index is the after', () => {
    expect(imageSides(file({ side: 'staged' }), null)).toEqual({
      before: { from: 'blob', source: { kind: 'head' }, path: 'img/a.png' },
      after: { from: 'blob', source: { kind: 'index' }, path: 'img/a.png' },
    });
  });

  it('compares unstaged work against the index, and the disk is the after', () => {
    expect(imageSides(file({ side: 'unstaged' }), null)).toEqual({
      before: { from: 'blob', source: { kind: 'index' }, path: 'img/a.png' },
      after: { from: 'worktree', path: 'img/a.png' },
    });
  });

  it('previews nothing that is text, conflicted, not an image, or a commit with no oid', () => {
    expect(imageSides(file({ binary: false }), OID)).toBeNull();
    expect(imageSides(file({ conflicted: true }), OID)).toBeNull();
    expect(imageSides(file({ oldPath: 'a.bin', newPath: 'a.bin' }), OID)).toBeNull();
    expect(imageSides(file(), null)).toBeNull();
  });
});

describe('formatBytes', () => {
  it('reads as people read sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('displayScale', () => {
  it('enlarges a small sprite by a whole factor, capped', () => {
    expect(displayScale(16, 16)).toBe(6);
    expect(displayScale(32, 20)).toBe(3);
    expect(displayScale(4, 4)).toBe(8);
  });

  it('leaves an ordinary image, and a broken size, alone', () => {
    expect(displayScale(96, 10)).toBe(1);
    expect(displayScale(800, 600)).toBe(1);
    expect(displayScale(0, 0)).toBe(1);
  });
});
