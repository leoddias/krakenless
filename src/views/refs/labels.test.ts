import { describe, expect, it } from 'vitest';
import { assertRefName } from '../../git/argsafety';
import { GitError } from '../../git/errors';
import type { Branch, StashEntry } from '../../git/types';
import {
  applyStashQuestion,
  branchNameError,
  deleteBranchQuestion,
  dropRecoveryCommand,
  dropStashQuestion,
  forceDeleteBranchQuestion,
  formatRelativeDate,
  groupBranches,
  localNameFor,
  popStashQuestion,
  stashLabel,
  trackingSummary,
} from './labels';

function branch(overrides: Partial<Branch> & { name: string }): Branch {
  return {
    current: false,
    oid: 'a'.repeat(40),
    ahead: 0,
    behind: 0,
    remote: false,
    ...overrides,
  };
}

function stash(overrides: Partial<StashEntry> = {}): StashEntry {
  return {
    ref: 'stash@{0}',
    oid: 'b'.repeat(40),
    index: 0,
    message: 'WIP on main: fix parser',
    date: '2026-08-19T10:00:00+00:00',
    ...overrides,
  };
}

describe('groupBranches', () => {
  it('splits local from remote-tracking branches', () => {
    const groups = groupBranches([
      branch({ name: 'main' }),
      branch({ name: 'origin/main', remote: true }),
      branch({ name: 'feature/x' }),
    ]);
    expect(groups.local.map((b) => b.name)).toEqual(['main', 'feature/x']);
    expect(groups.remote.map((b) => b.name)).toEqual(['origin/main']);
  });

  it('lifts the current branch to the top of the local list', () => {
    const groups = groupBranches([
      branch({ name: 'a' }),
      branch({ name: 'b' }),
      branch({ name: 'c', current: true }),
    ]);
    expect(groups.local.map((b) => b.name)).toEqual(['c', 'a', 'b']);
  });

  it('keeps git order otherwise', () => {
    const groups = groupBranches([branch({ name: 'b' }), branch({ name: 'a' })]);
    expect(groups.local.map((b) => b.name)).toEqual(['b', 'a']);
  });

  it('handles an empty list', () => {
    expect(groupBranches([])).toEqual({ local: [], remote: [] });
  });
});

describe('trackingSummary', () => {
  it('says so when there is no upstream', () => {
    expect(trackingSummary(branch({ name: 'main' }))).toBe('No upstream branch');
  });

  it('reports an up-to-date upstream', () => {
    expect(trackingSummary(branch({ name: 'main', upstream: 'origin/main' }))).toBe(
      'Tracks origin/main, up to date',
    );
  });

  it('reports divergence in both directions', () => {
    expect(
      trackingSummary(
        branch({ name: 'main', upstream: 'origin/main', ahead: 2, behind: 3 }),
      ),
    ).toBe('Tracks origin/main, 2 ahead, 3 behind');
  });
});

describe('localNameFor', () => {
  it('strips the remote prefix', () => {
    expect(localNameFor(branch({ name: 'origin/main', remote: true }))).toBe('main');
  });

  it('keeps the rest of the path for nested names', () => {
    expect(localNameFor(branch({ name: 'origin/feature/x', remote: true }))).toBe(
      'feature/x',
    );
  });

  it('returns null for a local branch', () => {
    expect(localNameFor(branch({ name: 'feature/x' }))).toBeNull();
  });

  it('returns null when no prefix can be stripped', () => {
    expect(localNameFor(branch({ name: 'weird', remote: true }))).toBeNull();
  });

  it('returns null when the derived name would not be a legal ref', () => {
    // `refs/remotes/origin/-x` is possible enough to matter: the derived name
    // must never become an option.
    expect(localNameFor(branch({ name: 'origin/-x', remote: true }))).toBeNull();
  });
});

describe('branchNameError', () => {
  it('accepts ordinary names', () => {
    for (const name of ['main', 'feature/x', 'release-1.2', 'user@host']) {
      expect(branchNameError(name)).toBeNull();
    }
  });

  it('rejects an empty name', () => {
    expect(branchNameError('')).toBe('Enter a branch name.');
  });

  it.each([
    ['--force', 'dash'],
    ['-D', 'dash'],
    ['+main', 'plus'],
    ['refs/heads/main', 'full ref'],
    ['my branch', 'space'],
    ['ca^ret', 'caret'],
    ['ti~lde', 'tilde'],
    ['co:lon', 'colon'],
    ['qu?estion', 'question mark'],
    ['sta*r', 'star'],
    ['brac[ket', 'bracket'],
    ['back\\slash', 'backslash'],
    ['a..b', 'double dot'],
    ['head@{0}', '@{'],
    ['trailing.', 'trailing dot'],
    ['trailing/', 'trailing slash'],
    ['branch.lock', '.lock'],
    ['/leading', 'leading slash'],
    ['double//slash', 'empty component'],
    ['@', 'bare @'],
    ['nul\u0000name', 'NUL'],
  ])('rejects %s (%s)', (name) => {
    expect(branchNameError(name)).not.toBeNull();
  });

  it('agrees with the git layer: everything it rejects, assertRefName rejects too', () => {
    const names = [
      '--force',
      '-D',
      '+main',
      'refs/heads/main',
      'my branch',
      'a..b',
      'head@{0}',
      'trailing.',
      'trailing/',
      'branch.lock',
      '/leading',
      'double//slash',
      '@',
      '',
      'nul\u0000name',
    ];
    for (const name of names) {
      expect(branchNameError(name)).not.toBeNull();
      expect(() => assertRefName(name)).toThrow(GitError);
    }
  });

  it('agrees with the git layer on names it accepts', () => {
    for (const name of ['main', 'feature/x', 'release-1.2']) {
      expect(branchNameError(name)).toBeNull();
      expect(assertRefName(name)).toBe(name);
    }
  });
});

describe('confirmation questions', () => {
  it('names the branch in the safe delete question', () => {
    expect(deleteBranchQuestion('feature/x')).toBe('Delete branch "feature/x"?');
  });

  it('names the branch and the consequence in the forcing question', () => {
    const question = forceDeleteBranchQuestion('feature/x');
    expect(question).toContain('"feature/x"');
    expect(question).toContain('not merged anywhere');
  });

  it('asks a different question for the forced delete', () => {
    expect(forceDeleteBranchQuestion('x')).not.toBe(deleteBranchQuestion('x'));
  });

  it('distinguishes apply from pop and names the stash', () => {
    const entry = stash({ message: 'WIP: parser' });
    expect(applyStashQuestion(entry)).toContain('WIP: parser');
    expect(applyStashQuestion(entry)).toContain('keeping it in the list');
    expect(popStashQuestion(entry)).toContain('remove it from the list');
    expect(dropStashQuestion(entry)).toContain('without applying it');
    expect(
      new Set([
        applyStashQuestion(entry),
        popStashQuestion(entry),
        dropStashQuestion(entry),
      ]).size,
    ).toBe(3);
  });
});

describe('stashLabel', () => {
  it('uses the message when there is one', () => {
    expect(stashLabel(stash({ message: 'WIP' }))).toBe('WIP');
  });

  it('falls back to the ref for a message-less entry', () => {
    expect(stashLabel(stash({ message: '', ref: 'stash@{2}' }))).toBe('stash@{2}');
  });
});

describe('dropRecoveryCommand', () => {
  it('names the oid, not the index that has already shifted', () => {
    const oid = 'b'.repeat(40);
    expect(dropRecoveryCommand(oid)).toBe(`git stash apply ${oid}`);
  });

  it('accepts a SHA-256 object id', () => {
    const oid = 'c'.repeat(64);
    expect(dropRecoveryCommand(oid)).toBe(`git stash apply ${oid}`);
  });

  it.each([
    ['deadbeef', 'abbreviated'],
    ['', 'empty'],
    ['Z'.repeat(40), 'not hex'],
    [`${'a'.repeat(40)}; rm -rf /`, 'trailing command'],
    [`${'a'.repeat(40)} --all`, 'trailing option'],
  ])('offers no command for %s (%s)', (oid) => {
    // The string is handed to the user to paste into a shell; anything that is
    // not an object id must not travel there dressed as one.
    expect(dropRecoveryCommand(oid)).toBeNull();
  });
});

describe('formatRelativeDate', () => {
  const now = new Date('2026-08-19T12:00:00Z');

  it.each([
    ['2026-08-19T11:59:30Z', 'just now'],
    ['2026-08-19T11:30:00Z', '30 minutes ago'],
    ['2026-08-19T09:00:00Z', '3 hours ago'],
    ['2026-08-17T12:00:00Z', '2 days ago'],
    ['2026-08-05T12:00:00Z', '2 weeks ago'],
    ['2026-05-19T12:00:00Z', '3 months ago'],
    // 730 days: two calendar years, but a hair under two average years — the
    // unit is floored, so an elapsed unit is never rounded up.
    ['2024-08-19T12:00:00Z', '1 year ago'],
    ['2023-08-19T12:00:00Z', '3 years ago'],
  ])('formats %s as %s', (iso, expected) => {
    expect(formatRelativeDate(iso, now)).toBe(expected);
  });

  it('returns unparsable input verbatim rather than a wrong date', () => {
    expect(formatRelativeDate('not a date', now)).toBe('not a date');
  });
});
