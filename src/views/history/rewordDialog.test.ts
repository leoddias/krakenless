import { describe, expect, it, vi } from 'vitest';
import { noOperation } from '../../git/operation';
import type { Branch, Commit, CommitRef } from '../../git/types';
import { rewordHeadCommit } from '../../state/actions';
import { createStore } from '../../state/store';
import {
  looksPublished,
  rewordDialog,
  rewordQuestion,
  rewordRefusal,
} from './rewordDialog';

vi.mock('../../state/actions', () => ({ rewordHeadCommit: vi.fn() }));

const HEAD: CommitRef = { kind: 'head', name: 'HEAD' };
const main: CommitRef = { kind: 'branch', name: 'main' };

function commit(refs: CommitRef[]): Commit {
  return {
    oid: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    shortOid: 'a1b2c3d',
    parents: [],
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    authorDate: '2026-08-20T10:00:00+00:00',
    committerName: 'Ada',
    committerDate: '2026-08-20T10:00:00+00:00',
    subject: 'fix the grpah',
    body: '',
    refs,
  };
}

function branch(overrides: Partial<Branch>): Branch {
  return {
    name: 'main',
    current: true,
    oid: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    ahead: 0,
    behind: 0,
    remote: false,
    ...overrides,
  };
}

describe('rewordRefusal', () => {
  it('allows a quiet repository', () => {
    expect(rewordRefusal(noOperation(), false, false)).toBeNull();
  });

  it('refuses while a command runs', () => {
    expect(rewordRefusal(noOperation(), true, false)).toMatch(/already running/);
  });

  it('refuses mid-operation, where HEAD is a step of it and not the tip', () => {
    const rebase = { ...noOperation(), kind: 'rebase' as const };
    expect(rewordRefusal(rebase, false, false)).toMatch(/rebase is in progress/);
  });

  it('refuses with conflicts', () => {
    expect(rewordRefusal(noOperation(), false, true)).toMatch(/conflicts/);
  });
});

describe('looksPublished', () => {
  it('is true when a remote-tracking branch sits on the commit', () => {
    const refs: CommitRef[] = [
      HEAD,
      main,
      { kind: 'remote-branch', name: 'origin/main' },
    ];
    expect(looksPublished(commit(refs), null)).toBe(true);
  });

  it('is true when the branch has an upstream and is not ahead of it', () => {
    expect(
      looksPublished(commit([HEAD, main]), [
        branch({ upstream: 'origin/main', ahead: 0 }),
      ]),
    ).toBe(true);
  });

  it('is false for a commit not pushed yet', () => {
    expect(
      looksPublished(commit([HEAD, main]), [
        branch({ upstream: 'origin/main', ahead: 1 }),
      ]),
    ).toBe(false);
    expect(looksPublished(commit([HEAD, main]), [branch({})])).toBe(false);
  });

  it('is false for a detached HEAD with nothing remote on it', () => {
    expect(looksPublished(commit([HEAD]), [branch({ upstream: 'origin/main' })])).toBe(
      false,
    );
  });

  it('does not take a remote branch of the same name for the local one', () => {
    expect(
      looksPublished(commit([HEAD, main]), [
        branch({ name: 'main', remote: true, upstream: 'x', ahead: 0 }),
      ]),
    ).toBe(false);
  });
});

describe('rewordQuestion', () => {
  it('names the commit and the branch', () => {
    expect(rewordQuestion(commit([HEAD, main]))).toMatch(
      /^Rewrite the message of a1b2c3d, the last commit on main\./,
    );
  });

  it('says so when HEAD is detached', () => {
    expect(rewordQuestion(commit([HEAD]))).toContain('the detached HEAD');
  });
});

describe('rewordDialog', () => {
  it('starts from the message as read and runs with the question as the reason', () => {
    const store = createStore();
    const target = commit([HEAD, main]);
    const dialog = rewordDialog(store, target, 'fix the grpah\n\nbody', []);

    expect(dialog.initial).toBe('fix the grpah\n\nbody');
    expect(dialog.warning).toBeUndefined();
    void dialog.run('fix the graph\n\nbody', dialog.question);
    expect(rewordHeadCommit).toHaveBeenCalledWith(
      store,
      target.oid,
      'main',
      'fix the graph\n\nbody',
      dialog.question,
    );
  });

  it('warns when the commit is already on a remote', () => {
    const refs: CommitRef[] = [
      HEAD,
      main,
      { kind: 'remote-branch', name: 'origin/main' },
    ];
    const dialog = rewordDialog(createStore(), commit(refs), 'x', null);
    expect(dialog.warning).toMatch(/force push/);
  });
});
