import { describe, expect, it, vi } from 'vitest';
import type { Branch } from '../../git/types';
import type { WorktreeSummary } from '../../git/worktrees';
import type { Loadable, Store } from '../../state/store';
import {
  branchAfterWorktreeRemove,
  deleteBranchDialog,
  localBranchAfterRemoteDelete,
} from './branchDialog';

const removeBranch = vi.hoisted(() => vi.fn());
vi.mock('../../state/actions', () => ({ removeBranch }));

const OID = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

function local(name: string, extra: Partial<Branch> = {}): Branch {
  return { name, current: false, oid: OID, ahead: 0, behind: 0, remote: false, ...extra };
}

function remote(name: string): Branch {
  return { name, current: false, oid: OID, ahead: 0, behind: 0, remote: true };
}

function ready<T>(value: T): Loadable<T> {
  return { state: 'ready', value } as Loadable<T>;
}

function worktree(path: string, branch: string | null): WorktreeSummary {
  return {
    path,
    head: OID,
    branch,
    detached: branch === null,
    bare: false,
    locked: null,
    prunable: null,
    main: false,
    changed: 0,
    untracked: 0,
  };
}

const NO_WORKTREES = ready<WorktreeSummary[]>([]);

describe('the local branch offered after a remote delete', () => {
  it('is the one tracking the deleted branch', () => {
    const branches = ready([
      local('topic-local', { upstream: 'origin/feat/x' }),
      remote('origin/feat/x'),
    ]);
    expect(localBranchAfterRemoteDelete('origin/feat/x', branches, NO_WORKTREES)).toBe(
      'topic-local',
    );
  });

  it('falls back to a namesake that tracks nothing', () => {
    const branches = ready([local('feat/x'), remote('origin/feat/x')]);
    expect(localBranchAfterRemoteDelete('origin/feat/x', branches, NO_WORKTREES)).toBe(
      'feat/x',
    );
  });

  it('is not a namesake following another remote', () => {
    // Its config names a fork; deleting it because origin's copy went would
    // delete somebody's work under a name that only looks the same.
    const branches = ready([
      local('feat/x', { upstream: 'fork/feat/x' }),
      remote('origin/feat/x'),
    ]);
    expect(
      localBranchAfterRemoteDelete('origin/feat/x', branches, NO_WORKTREES),
    ).toBeNull();
  });

  it('is not offered for the branch checked out here, which git refuses', () => {
    const branches = ready([local('feat/x', { current: true }), remote('origin/feat/x')]);
    expect(
      localBranchAfterRemoteDelete('origin/feat/x', branches, NO_WORKTREES),
    ).toBeNull();
  });

  it('is not offered for a branch another worktree has checked out', () => {
    const branches = ready([local('feat/x'), remote('origin/feat/x')]);
    const worktrees = ready([worktree('C:/repos/app-x', 'feat/x')]);
    expect(localBranchAfterRemoteDelete('origin/feat/x', branches, worktrees)).toBeNull();
  });

  it('is nothing when there is no local branch, or the list is unread', () => {
    expect(
      localBranchAfterRemoteDelete(
        'origin/feat/x',
        ready([remote('origin/feat/x')]),
        NO_WORKTREES,
      ),
    ).toBeNull();
    expect(
      localBranchAfterRemoteDelete(
        'origin/feat/x',
        { state: 'loading' } as Loadable<Branch[]>,
        NO_WORKTREES,
      ),
    ).toBeNull();
  });
});

describe('the branch offered after a worktree is removed', () => {
  const WIKI = worktree('C:/repos/app-wiki', 'wiki');

  it('is the branch it had checked out, which it no longer holds', () => {
    // The removed worktree is still in the list the menu was built from; it
    // must not count as somebody holding the branch.
    expect(branchAfterWorktreeRemove(WIKI, ready([local('wiki')]), ready([WIKI]))).toBe(
      'wiki',
    );
  });

  it('is nothing for a detached worktree', () => {
    const detached = worktree('C:/repos/app-wiki', null);
    expect(
      branchAfterWorktreeRemove(detached, ready([local('wiki')]), ready([detached])),
    ).toBeNull();
  });

  it('is nothing when that branch is checked out here', () => {
    expect(
      branchAfterWorktreeRemove(
        WIKI,
        ready([local('wiki', { current: true })]),
        ready([WIKI]),
      ),
    ).toBeNull();
  });
});

describe('the branch delete dialog', () => {
  const store = {} as Store;

  it('asks the safe question, with the reason the refs panel uses', async () => {
    removeBranch.mockResolvedValue({ deleted: true });
    const dialog = deleteBranchDialog(store, 'wiki', 'Also delete branch "wiki"?');

    expect(dialog.title).toBe('Also delete branch "wiki"?');
    expect(dialog.question).toBe('Delete branch "wiki"?');
    await dialog.run(dialog.question);
    expect(removeBranch).toHaveBeenCalledWith(store, 'wiki', 'Delete branch "wiki"?', {
      force: false,
    });
    expect(dialog.escalate?.({ deleted: true })).toBeNull();
  });

  it('turns git’s refusal into an armed second question, never a forced delete', () => {
    const dialog = deleteBranchDialog(store, 'wiki');
    const next = dialog.escalate?.({ deleted: false, unmergedWarning: 'not merged' });

    expect(next?.arm).toBeDefined();
    expect(next?.detail).toBe('not merged');
    expect(next?.question).toContain('anyway');
  });
});
