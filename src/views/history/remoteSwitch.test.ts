import { describe, expect, it } from 'vitest';
import type { Branch, CommitRef } from '../../git/types';
import { remoteSwitchFor } from './remoteSwitch';

const AT = 'f'.repeat(40);
const BEHIND = 'e'.repeat(40);

const remoteChip: CommitRef = { kind: 'remote-branch', name: 'origin/main' };

function local(name: string, overrides: Partial<Branch> = {}): Branch {
  return {
    name,
    current: false,
    oid: BEHIND,
    ahead: 0,
    behind: 0,
    remote: false,
    ...overrides,
  };
}

function remote(name: string): Branch {
  return { name, current: false, oid: AT, ahead: 0, behind: 0, remote: true };
}

describe('remoteSwitchFor', () => {
  it('asks for nothing when the row has no remote-tracking chip', () => {
    expect(
      remoteSwitchFor([{ kind: 'tag', name: 'v1' }], AT, [remote('origin/main')]),
    ).toBeNull();
    expect(remoteSwitchFor([], AT, [remote('origin/main')])).toBeNull();
  });

  it('waits for the branch list before deciding', () => {
    // Without the list there is no way to tell a branch that tracks the remote
    // from one that does not exist; creating one blindly could collide.
    expect(remoteSwitchFor([remoteChip], AT, null)).toBeNull();
  });

  it('moves the checked-out branch forward when it tracks the remote and fell behind', () => {
    // The bug that motivated this: on `main`, behind `origin/main`, the double
    // click on the remote row did nothing.
    const branches = [
      local('main', { current: true, upstream: 'origin/main', behind: 3 }),
      remote('origin/main'),
    ];
    expect(remoteSwitchFor([remoteChip], AT, branches)).toEqual({
      kind: 'forward',
      name: 'main',
      remoteRef: 'origin/main',
      current: true,
    });
  });

  it('switches to the tracking branch and moves it forward when it is not the checkout', () => {
    const branches = [
      local('feat/x', { current: true }),
      local('main', { upstream: 'origin/main' }),
      remote('origin/main'),
    ];
    expect(remoteSwitchFor([remoteChip], AT, branches)).toEqual({
      kind: 'forward',
      name: 'main',
      remoteRef: 'origin/main',
      current: false,
    });
  });

  it('prefers the branch whose upstream is the remote over one that merely shares the name', () => {
    const branches = [
      local('main'),
      local('trunk', { upstream: 'origin/main' }),
      remote('origin/main'),
    ];
    expect(remoteSwitchFor([remoteChip], AT, branches)?.name).toBe('trunk');
  });

  it('falls back to the branch sharing the remote name when none tracks it', () => {
    const branches = [local('main'), remote('origin/main')];
    expect(remoteSwitchFor([remoteChip], AT, branches)).toMatchObject({
      kind: 'forward',
      name: 'main',
    });
  });

  it('leaves a namesake alone when it tracks a different remote', () => {
    // Fork workflow: `main` follows `upstream/main`. `origin/main` is not what
    // it stands for, and creating a second `main` is impossible, so: nothing.
    const branches = [
      local('main', { upstream: 'upstream/main' }),
      remote('origin/main'),
      remote('upstream/main'),
    ];
    expect(remoteSwitchFor([remoteChip], AT, branches)).toBeNull();
  });

  it('creates the local branch when none stands for the remote', () => {
    const branches = [local('feat/x', { current: true }), remote('origin/main')];
    expect(remoteSwitchFor([remoteChip], AT, branches)).toEqual({
      kind: 'create',
      name: 'main',
      remoteRef: 'origin/main',
    });
  });

  it('creates nothing when no local name can be derived', () => {
    // The refs panel says "No local name can be derived" for the same row.
    const chip: CommitRef = { kind: 'remote-branch', name: 'origin/HEAD' };
    expect(remoteSwitchFor([chip], AT, [remote('origin/HEAD')])).toBeNull();
  });

  it('does nothing when the checkout already stands on this commit', () => {
    const branches = [
      local('main', { current: true, oid: AT, upstream: 'origin/main' }),
      remote('origin/main'),
    ];
    expect(remoteSwitchFor([remoteChip], AT, branches)).toBeNull();
  });

  it('still answers "forward" for a branch that is ahead — git is what refuses', () => {
    // The rule does not read ahead/behind counts: they are only as fresh as
    // the last fetch, and `--ff-only` is the check that cannot be stale.
    const branches = [
      local('main', { current: true, upstream: 'origin/main', ahead: 2 }),
      remote('origin/main'),
    ];
    expect(remoteSwitchFor([remoteChip], AT, branches)?.kind).toBe('forward');
  });

  it('reads the first remote-tracking chip when several share the row', () => {
    const refs: CommitRef[] = [
      { kind: 'remote-branch', name: 'origin/main' },
      { kind: 'remote-branch', name: 'upstream/main' },
    ];
    const branches = [remote('origin/main'), remote('upstream/main')];
    expect(remoteSwitchFor(refs, AT, branches)?.remoteRef).toBe('origin/main');
  });
});
