import { describe, expect, it } from 'vitest';
import { assertRefName } from '../../git/argsafety';
import { GitError } from '../../git/errors';
import type { Branch, StashEntry, Tag } from '../../git/types';
import {
  applyStashQuestion,
  branchAncestors,
  branchNameError,
  deleteBranchQuestion,
  deleteRemoteBranchQuestion,
  dropRecoveryCommand,
  dropStashQuestion,
  forceDeleteBranchQuestion,
  formatRelativeDate,
  branchRef,
  deleteRemoteTagDetail,
  deleteRemoteTagQuestion,
  deleteTagDetail,
  deleteTagQuestion,
  groupBranches,
  isBranchSelected,
  isTagSelected,
  localNameFor,
  remoteTagDeleteRecovery,
  tagRef,
  tagRestoreCommand,
  popStashQuestion,
  stashLabel,
  trackingSummary,
  remoteDeleteRecovery,
  splitRemoteBranch,
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

function tag(overrides: Partial<Tag> & { name: string }): Tag {
  return {
    oid: 'a'.repeat(40),
    object: 'a'.repeat(40),
    annotated: false,
    date: '2026-09-19T10:00:00+00:00',
    subject: '',
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

describe('isBranchSelected', () => {
  const main = branch({ name: 'main', oid: 'a'.repeat(40) });
  const twin = branch({ name: 'origin/main', oid: 'a'.repeat(40), remote: true });

  it('marks only the branch the selection was made through', () => {
    // The point of carrying the ref: both of these sit on the same commit, and
    // lighting up both answers a question nobody asked.
    expect(isBranchSelected(main, 'refs/remotes/origin/main', 'a'.repeat(40))).toBe(
      false,
    );
    expect(isBranchSelected(twin, 'refs/remotes/origin/main', 'a'.repeat(40))).toBe(true);
    expect(isBranchSelected(main, 'refs/heads/main', 'a'.repeat(40))).toBe(true);
    expect(isBranchSelected(twin, 'refs/heads/main', 'a'.repeat(40))).toBe(false);
  });

  it('tells a tag apart from a branch of the same name', () => {
    // Git allows both at once, and their short names are identical: the path
    // is the only thing that says which one the click was about.
    const release = branch({ name: 'release', oid: 'a'.repeat(40) });
    expect(isBranchSelected(release, 'refs/tags/release', 'a'.repeat(40))).toBe(false);
    expect(isBranchSelected(release, 'refs/heads/release', 'a'.repeat(40))).toBe(true);
  });

  it('falls back to the commit when the selection names no ref', () => {
    expect(isBranchSelected(main, null, 'a'.repeat(40))).toBe(true);
    expect(isBranchSelected(main, null, 'b'.repeat(40))).toBe(false);
  });

  it('marks nothing when nothing is selected', () => {
    expect(isBranchSelected(main, null, null)).toBe(false);
  });

  it('marks nothing when the named ref is not in the list', () => {
    expect(isBranchSelected(main, 'refs/heads/feature/x', 'a'.repeat(40))).toBe(false);
  });
});

describe('branchAncestors', () => {
  it('names every row that has to be open for a branch to be on screen', () => {
    expect(branchAncestors('feat/ui/tabs')).toEqual(['feat', 'feat/ui']);
    expect(branchAncestors('origin/feat/x')).toEqual(['origin', 'origin/feat']);
  });

  it('is empty for a branch that sits at the top of the list', () => {
    expect(branchAncestors('main')).toEqual([]);
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

describe('splitRemoteBranch', () => {
  it('splits at the first slash, which is the only split git gives', () => {
    expect(splitRemoteBranch('origin/main')).toEqual({
      remote: 'origin',
      branch: 'main',
    });
    expect(splitRemoteBranch('origin/feat/tickets-service')).toEqual({
      remote: 'origin',
      branch: 'feat/tickets-service',
    });
  });

  it.each([
    ['no slash at all', 'main'],
    ['nothing before the slash', '/main'],
    ['nothing after it', 'origin/'],
    ['the symref, not a branch', 'origin/HEAD'],
    ['nothing', ''],
  ])('refuses %s', (_why, name) => {
    // A name this cannot split gets no delete button: the push would have to
    // guess which half is the remote, and guessing wrong deletes a ref on a
    // server.
    expect(splitRemoteBranch(name)).toBeNull();
  });
});

describe('deleteRemoteBranchQuestion', () => {
  it('says it is for everyone, which is the whole difference', () => {
    const question = deleteRemoteBranchQuestion({ remote: 'origin', branch: 'feat/x' });

    expect(question).toContain('feat/x');
    expect(question).toContain('origin');
    expect(question).toMatch(/for everyone/);
  });
});

describe('remoteDeleteRecovery', () => {
  const ref = { remote: 'origin', branch: 'feat/x' };

  it('pushes the oid back to the name it had', () => {
    const oid = 'a'.repeat(40);
    expect(remoteDeleteRecovery(ref, oid)).toBe(
      `git push origin ${oid}:refs/heads/feat/x`,
    );
  });

  it('offers nothing for an oid it cannot vouch for', () => {
    // This string is handed to the user to paste into a shell.
    expect(remoteDeleteRecovery(ref, 'HEAD')).toBeNull();
    expect(remoteDeleteRecovery(ref, 'a1b2c3d')).toBeNull();
    expect(remoteDeleteRecovery(ref, '')).toBeNull();
  });
});

describe('the ref path a row stands for', () => {
  it('puts a local branch, a remote-tracking one and a tag in their own namespaces', () => {
    expect(branchRef(branch({ name: 'main' }))).toBe('refs/heads/main');
    expect(branchRef(branch({ name: 'origin/main', remote: true }))).toBe(
      'refs/remotes/origin/main',
    );
    expect(tagRef(tag({ name: 'v1.0' }))).toBe('refs/tags/v1.0');
  });
});

describe('isTagSelected', () => {
  const v1 = tag({ name: 'v1.0', oid: 'a'.repeat(40) });

  it('marks the tag the selection named', () => {
    expect(isTagSelected(v1, 'refs/tags/v1.0', 'a'.repeat(40))).toBe(true);
  });

  it('does not answer to a branch of the same name', () => {
    const release = tag({ name: 'release', oid: 'a'.repeat(40) });
    expect(isTagSelected(release, 'refs/heads/release', 'a'.repeat(40))).toBe(false);
  });

  it('falls back to the commit when the selection names no ref', () => {
    expect(isTagSelected(v1, null, 'a'.repeat(40))).toBe(true);
    expect(isTagSelected(v1, null, 'b'.repeat(40))).toBe(false);
    expect(isTagSelected(v1, null, null)).toBe(false);
  });
});

describe('the tag questions', () => {
  it('names the tag in the local question', () => {
    expect(deleteTagQuestion('v1.0')).toBe('Delete tag "v1.0"?');
  });

  it('says the remote one goes for everyone, which is its whole difference', () => {
    expect(deleteRemoteTagQuestion({ remote: 'origin', tag: 'v1.0' })).toBe(
      'Delete tag "v1.0" from origin — for everyone who uses that remote?',
    );
  });
});

describe('the tag details', () => {
  it('promises a way back only when there is one', () => {
    expect(deleteTagDetail('git update-ref refs/tags/v1.0 abc')).toContain(
      'puts it back',
    );
    expect(deleteTagDetail(null)).toContain('no way back');
  });

  it('does not claim a fetch removes the tag from anyone who has it', () => {
    // It does not: that needs `--prune-tags`. Saying otherwise would have the
    // user believe a bad release tag is gone from machines it is still on.
    const detail = deleteRemoteTagDetail('origin');
    expect(detail).toContain('prune-tags');
    expect(detail).toMatch(/already fetched stay/);
  });
});

describe('tagRestoreCommand', () => {
  it('names the object the ref pointed at, so an annotated tag comes back whole', () => {
    // `git tag v2.0 <commit>` would resolve the tag object to its commit and
    // recreate the tag lightweight, dropping the message and the tagger.
    const annotated = tag({
      name: 'v2.0',
      annotated: true,
      oid: 'a'.repeat(40),
      object: 'b'.repeat(40),
    });
    expect(tagRestoreCommand(annotated)).toBe(
      `git update-ref refs/tags/v2.0 ${'b'.repeat(40)}`,
    );
  });

  it('works the same for a lightweight tag, whose two ids are one', () => {
    expect(tagRestoreCommand(tag({ name: 'v1.0' }))).toBe(
      `git update-ref refs/tags/v1.0 ${'a'.repeat(40)}`,
    );
  });

  it('offers nothing when the object is not an object id', () => {
    // The string is handed to the user to paste into a shell: something that
    // is not an oid must not travel there as if it were one.
    expect(tagRestoreCommand(tag({ name: 'v1.0', object: 'HEAD' }))).toBeNull();
    expect(tagRestoreCommand(tag({ name: 'v1.0', object: '' }))).toBeNull();
  });

  it('offers nothing for a name a shell would read as more than a name', () => {
    // git accepts `;`, `$`, backticks and quotes in a ref name; a shell reads
    // them as syntax. A tag out of someone else's repository is text they
    // chose, and this line sits under a label telling the user to run it.
    for (const name of [
      'v1;rm -rf ~',
      'v1$(whoami)',
      'v1`id`',
      "v1'|sh",
      'v1 && curl evil',
      '-v1',
    ]) {
      expect(tagRestoreCommand(tag({ name }))).toBeNull();
    }
  });

  it('still offers one for the names tags actually have', () => {
    for (const name of ['v1.0', 'release-1.0.4', 'release/2026.09', 'v1_rc.2']) {
      expect(tagRestoreCommand(tag({ name }))).toContain(`refs/tags/${name}`);
    }
  });
});

describe('remoteTagDeleteRecovery', () => {
  const ref = { remote: 'origin', tag: 'v1.0' };

  it('pushes the object back under a fully qualified name', () => {
    // Qualified on the right-hand side so the push cannot land on a branch
    // that happens to share the name.
    expect(remoteTagDeleteRecovery(ref, 'b'.repeat(40))).toBe(
      `git push origin ${'b'.repeat(40)}:refs/tags/v1.0`,
    );
  });

  it('offers nothing when the object is not an object id', () => {
    expect(remoteTagDeleteRecovery(ref, 'v1.0^{}')).toBeNull();
  });

  it('offers nothing when the tag or the remote would carry shell syntax', () => {
    expect(
      remoteTagDeleteRecovery({ remote: 'origin', tag: 'v1;id' }, 'b'.repeat(40)),
    ).toBeNull();
    expect(
      remoteTagDeleteRecovery({ remote: 'o;id', tag: 'v1.0' }, 'b'.repeat(40)),
    ).toBeNull();
  });
});
