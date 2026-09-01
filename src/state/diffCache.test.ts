import { beforeEach, describe, expect, it } from 'vitest';
import type { FileDiff } from '../git/types';
import { cacheDiff, clearDiffCache, getCachedDiff } from './diffCache';

function files(path: string): FileDiff[] {
  return [
    {
      oldPath: path,
      newPath: path,
      kind: 'modified',
      binary: false,
      conflicted: false,
      side: 'commit',
      headerLines: [],
      hunks: [],
    },
  ];
}

const ROOT = 'C:/repos/app';

beforeEach(clearDiffCache);

describe('diffCache', () => {
  it('misses until stored, then hits', () => {
    expect(getCachedDiff(ROOT, 'abc')).toBeUndefined();
    const value = files('a.ts');
    cacheDiff(ROOT, 'abc', value);
    expect(getCachedDiff(ROOT, 'abc')).toBe(value);
  });

  it('keys by repository root as well as oid', () => {
    cacheDiff(ROOT, 'abc', files('a.ts'));
    expect(getCachedDiff('C:/repos/other', 'abc')).toBeUndefined();
  });

  it('evicts the least recently used entry beyond the cap', () => {
    for (let i = 0; i < 16; i += 1) cacheDiff(ROOT, `oid-${i}`, files(`f${i}`));
    // Touch the oldest so it becomes the newest.
    expect(getCachedDiff(ROOT, 'oid-0')).toBeDefined();
    cacheDiff(ROOT, 'one-too-many', files('overflow'));

    // The touched entry survived; the untouched runner-up did not.
    expect(getCachedDiff(ROOT, 'oid-0')).toBeDefined();
    expect(getCachedDiff(ROOT, 'oid-1')).toBeUndefined();
    expect(getCachedDiff(ROOT, 'one-too-many')).toBeDefined();
  });

  it('replaces an entry stored twice instead of duplicating it', () => {
    cacheDiff(ROOT, 'abc', files('old'));
    const newer = files('new');
    cacheDiff(ROOT, 'abc', newer);
    expect(getCachedDiff(ROOT, 'abc')).toBe(newer);
  });

  it('forgets everything on clear', () => {
    cacheDiff(ROOT, 'abc', files('a.ts'));
    clearDiffCache();
    expect(getCachedDiff(ROOT, 'abc')).toBeUndefined();
  });
});
