import { describe, expect, it } from 'vitest';
import { hasTrackedChanges } from './status';
import type { FileState, RepoStatus, StatusEntry } from './types';

function entry(index: FileState, worktree: FileState, conflicted = false): StatusEntry {
  return { path: 'a.txt', index, worktree, conflicted };
}

function status(entries: StatusEntry[]): RepoStatus {
  return { branch: 'main', head: 'abc', detached: false, entries, hasConflicts: false };
}

describe('hasTrackedChanges', () => {
  it('is false for a clean tree', () => {
    expect(hasTrackedChanges(status([]))).toBe(false);
    expect(hasTrackedChanges(status([entry('unmodified', 'unmodified')]))).toBe(false);
  });

  it('is true for a staged change', () => {
    expect(hasTrackedChanges(status([entry('modified', 'unmodified')]))).toBe(true);
  });

  it('is true for an unstaged change', () => {
    expect(hasTrackedChanges(status([entry('unmodified', 'modified')]))).toBe(true);
  });

  it('is true for a deletion on either side', () => {
    expect(hasTrackedChanges(status([entry('deleted', 'unmodified')]))).toBe(true);
    expect(hasTrackedChanges(status([entry('unmodified', 'deleted')]))).toBe(true);
  });

  // git replays commits over untracked and ignored files without complaint, so
  // counting them here would refuse operations git would have run.
  it('ignores untracked and ignored files', () => {
    expect(hasTrackedChanges(status([entry('untracked', 'untracked')]))).toBe(false);
    expect(hasTrackedChanges(status([entry('ignored', 'ignored')]))).toBe(false);
  });

  it('counts an untracked file alongside a tracked change', () => {
    const entries = [entry('untracked', 'untracked'), entry('unmodified', 'modified')];
    expect(hasTrackedChanges(status(entries))).toBe(true);
  });

  it('counts a conflicted path however git labelled its sides', () => {
    expect(hasTrackedChanges(status([entry('unmodified', 'unmodified', true)]))).toBe(
      true,
    );
  });
});
