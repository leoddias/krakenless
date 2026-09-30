import { describe, expect, it } from 'vitest';
import type { CommitRef } from '../../git/types';
import {
  checkedOutBranch,
  isCurrentChip,
  isHeadRow,
  isRedundantHeadChip,
} from './headRef';

const HEAD: CommitRef = { kind: 'head', name: 'HEAD' };
const branch = (name: string): CommitRef => ({ kind: 'branch', name });
const remote = (name: string): CommitRef => ({ kind: 'remote-branch', name });
const tag = (name: string): CommitRef => ({ kind: 'tag', name });

describe('checkedOutBranch', () => {
  it('reads the branch that follows the HEAD marker', () => {
    expect(checkedOutBranch([HEAD, branch('main')])).toBe('main');
  });

  it('ignores other branches parked on the same commit', () => {
    expect(checkedOutBranch([HEAD, branch('main'), branch('release')])).toBe('main');
  });

  it('is null on a detached HEAD, where no branch follows the marker', () => {
    expect(checkedOutBranch([HEAD, tag('v0.1.0')])).toBeNull();
    expect(checkedOutBranch([HEAD])).toBeNull();
    expect(checkedOutBranch([HEAD, remote('origin/main')])).toBeNull();
  });

  it('is null on a row HEAD is not on, whatever else it carries', () => {
    expect(checkedOutBranch([])).toBeNull();
    expect(checkedOutBranch([branch('main'), remote('origin/main')])).toBeNull();
  });
});

describe('isHeadRow', () => {
  it('is true for an attached and a detached HEAD alike', () => {
    expect(isHeadRow([HEAD, branch('main')])).toBe(true);
    expect(isHeadRow([HEAD])).toBe(true);
  });

  it('is false for every other row', () => {
    expect(isHeadRow([])).toBe(false);
    expect(isHeadRow([branch('main'), tag('v1')])).toBe(false);
  });
});

describe('isCurrentChip', () => {
  it('marks the branch HEAD points at, and no other branch', () => {
    expect(isCurrentChip(branch('main'), 'main')).toBe(true);
    expect(isCurrentChip(branch('release'), 'main')).toBe(false);
  });

  it('marks the HEAD chip itself only when the checkout is detached', () => {
    expect(isCurrentChip(HEAD, null)).toBe(true);
    expect(isCurrentChip(HEAD, 'main')).toBe(false);
  });

  it('never marks a remote branch that shares the checked-out name', () => {
    expect(isCurrentChip(remote('origin/main'), 'main')).toBe(false);
    expect(isCurrentChip(tag('main'), 'main')).toBe(false);
  });
});

describe('isRedundantHeadChip', () => {
  it('drops the HEAD chip when a branch chip carries the mark instead', () => {
    expect(isRedundantHeadChip(HEAD, 'main')).toBe(true);
  });

  it('keeps the HEAD chip when detached — nothing else would show it', () => {
    expect(isRedundantHeadChip(HEAD, null)).toBe(false);
  });

  it('never drops a chip that is not HEAD', () => {
    expect(isRedundantHeadChip(branch('main'), 'main')).toBe(false);
  });
});
