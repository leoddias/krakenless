import { describe, expect, it } from 'vitest';
import type { Branch, RepoStatus } from '../../git/types';
import type { Loadable } from '../../state/store';
import {
  candidateRemotes,
  fetchBlock,
  parseUpstream,
  pullBlock,
  pushBlock,
  pushIntent,
  readUpstream,
  summarize,
  type Gate,
} from './remotes';

function status(overrides: Partial<RepoStatus> = {}): Loadable<RepoStatus> {
  return {
    state: 'ready',
    value: {
      branch: 'main',
      head: 'a'.repeat(40),
      detached: false,
      ahead: 0,
      behind: 0,
      entries: [],
      hasConflicts: false,
      ...overrides,
    },
  };
}

function branch(overrides: Partial<Branch> & { name: string }): Branch {
  return {
    current: false,
    oid: 'b'.repeat(40),
    ahead: 0,
    behind: 0,
    remote: false,
    ...overrides,
  };
}

function gate(overrides: Partial<Gate> = {}): Gate {
  return {
    repoOpen: true,
    busy: false,
    statusState: 'ready',
    hasConflicts: false,
    upstream: {
      kind: 'tracking',
      branch: 'main',
      upstream: { remote: 'origin', branch: 'main' },
      ahead: 0,
      behind: 0,
    },
    branchesState: 'ready',
    publishRemote: 'origin',
    ...overrides,
  };
}

describe('parseUpstream', () => {
  it('splits a remote-tracking ref at the first slash', () => {
    expect(parseUpstream('origin/main')).toEqual({ remote: 'origin', branch: 'main' });
  });

  it('keeps slashes in the branch half', () => {
    expect(parseUpstream('upstream/feature/nested/name')).toEqual({
      remote: 'upstream',
      branch: 'feature/nested/name',
    });
  });

  it('refuses refs with no branch half', () => {
    expect(parseUpstream('origin/')).toBeNull();
  });

  it('refuses refs with no remote half', () => {
    expect(parseUpstream('/main')).toBeNull();
  });

  it('refuses refs with no slash at all', () => {
    expect(parseUpstream('main')).toBeNull();
  });

  it('refuses an empty ref', () => {
    expect(parseUpstream('')).toBeNull();
  });
});

describe('readUpstream', () => {
  it('is unknown while the status has not been read', () => {
    expect(readUpstream({ state: 'loading' })).toEqual({ kind: 'unknown' });
    expect(readUpstream({ state: 'idle' })).toEqual({ kind: 'unknown' });
    expect(readUpstream({ state: 'error', message: 'boom' })).toEqual({
      kind: 'unknown',
    });
  });

  it('reports a detached HEAD', () => {
    expect(readUpstream(status({ detached: true, branch: null }))).toEqual({
      kind: 'detached',
    });
  });

  it('reports an unborn branch', () => {
    expect(readUpstream(status({ head: null }))).toEqual({
      kind: 'unborn',
      branch: 'main',
    });
  });

  it('reports a branch with no upstream', () => {
    expect(readUpstream(status())).toEqual({ kind: 'no-upstream', branch: 'main' });
  });

  it('splits the upstream and carries the counts', () => {
    expect(
      readUpstream(status({ upstream: 'origin/main', ahead: 2, behind: 3 })),
    ).toEqual({
      kind: 'tracking',
      branch: 'main',
      upstream: { remote: 'origin', branch: 'main' },
      ahead: 2,
      behind: 3,
    });
  });

  it('refuses to guess at an upstream it cannot split', () => {
    expect(readUpstream(status({ upstream: 'weird' }))).toEqual({
      kind: 'unreadable-upstream',
      branch: 'main',
      upstream: 'weird',
    });
  });
});

describe('summarize', () => {
  it('never shows counts for a status that is still loading', () => {
    const summary = summarize({ state: 'loading' });
    expect(summary.headline).toBe('Reading branch status…');
    expect(`${summary.headline} ${summary.detail}`).not.toMatch(/\d/);
  });

  it('never shows counts for a failed status read', () => {
    const summary = summarize({
      state: 'error',
      message: 'git exploded',
      kind: 'timeout',
    });
    expect(summary.headline).toBe('Branch status unavailable');
    expect(summary.detail).toContain('git exploded');
    expect(summary.detail).toContain('timeout');
  });

  it('says when no repository is open', () => {
    expect(summarize({ state: 'idle' }).headline).toBe('No repository open');
  });

  it('reports both counts when the branch has diverged', () => {
    const summary = summarize(status({ upstream: 'origin/main', ahead: 2, behind: 3 }));
    expect(summary.headline).toBe('main → origin/main');
    expect(summary.detail).toContain('2 ahead');
    expect(summary.detail).toContain('3 behind');
  });

  it('omits the zero side', () => {
    const summary = summarize(status({ upstream: 'origin/main', ahead: 2 }));
    expect(summary.detail).toContain('2 ahead');
    expect(summary.detail).not.toContain('behind');
  });

  it('attributes a zero-zero comparison to git rather than asserting it', () => {
    // `RepoStatus` cannot express "unknown", so a status git returned without a
    // `branch.ab` record also lands here as 0/0. The sentence must survive that.
    expect(summarize(status({ upstream: 'origin/main' })).detail).toContain(
      'Git reported no commits on either side',
    );
  });

  it('names the missing upstream', () => {
    expect(summarize(status()).headline).toBe('main — no upstream');
  });

  it('names a detached HEAD', () => {
    expect(summarize(status({ detached: true, branch: null })).headline).toBe(
      'Detached HEAD',
    );
  });
});

describe('candidateRemotes — the real remote list wins', () => {
  const remote = (name: string) => ({
    name,
    fetchUrl: `https://x/${name}`,
    pushUrl: `https://x/${name}`,
  });

  it('names a remote that has never been fetched from', () => {
    // Its tracking refs do not exist yet, so a branch-derived list cannot see
    // it and the publish picker would silently omit it.
    const names = candidateRemotes(
      { state: 'ready', value: [] },
      { state: 'ready', value: [remote('upstream'), remote('origin')] },
    );
    expect(names).toEqual(['origin', 'upstream']);
  });

  it('falls back to branch-derived names while the remotes read is pending', () => {
    const names = candidateRemotes(
      {
        state: 'ready',
        value: [
          {
            name: 'origin/main',
            current: false,
            oid: 'a'.repeat(40),
            ahead: 0,
            behind: 0,
            remote: true,
          },
        ],
      },
      { state: 'loading' },
    );
    expect(names).toEqual(['origin']);
  });

  it('falls back when the remotes read failed', () => {
    const names = candidateRemotes(
      {
        state: 'ready',
        value: [
          {
            name: 'origin/main',
            current: false,
            oid: 'a'.repeat(40),
            ahead: 0,
            behind: 0,
            remote: true,
          },
        ],
      },
      { state: 'error', message: 'boom' },
    );
    expect(names).toEqual(['origin']);
  });

  it('keeps origin first and the rest alphabetical', () => {
    const names = candidateRemotes(
      { state: 'idle' },
      { state: 'ready', value: [remote('zeta'), remote('alpha'), remote('origin')] },
    );
    expect(names).toEqual(['origin', 'alpha', 'zeta']);
  });
});

describe('candidateRemotes', () => {
  it('is empty until the branch list is read', () => {
    expect(candidateRemotes({ state: 'idle' })).toEqual([]);
    expect(candidateRemotes({ state: 'error', message: 'nope' })).toEqual([]);
  });

  it('recovers remote names from remote-tracking branches', () => {
    const branches: Loadable<Branch[]> = {
      state: 'ready',
      value: [
        branch({ name: 'origin/main', remote: true }),
        branch({ name: 'fork/main', remote: true }),
        branch({ name: 'main', current: true }),
      ],
    };
    expect(candidateRemotes(branches)).toEqual(['origin', 'fork']);
  });

  it('also recovers them from local upstreams, without duplicates', () => {
    const branches: Loadable<Branch[]> = {
      state: 'ready',
      value: [
        branch({ name: 'main', upstream: 'origin/main' }),
        branch({ name: 'topic', upstream: 'origin/topic' }),
        branch({ name: 'other', upstream: 'alpha/other' }),
      ],
    };
    expect(candidateRemotes(branches)).toEqual(['origin', 'alpha']);
  });

  it('sorts origin first and the rest alphabetically', () => {
    const branches: Loadable<Branch[]> = {
      state: 'ready',
      value: [
        branch({ name: 'zed/main', remote: true }),
        branch({ name: 'alpha/main', remote: true }),
        branch({ name: 'origin/main', remote: true }),
      ],
    };
    expect(candidateRemotes(branches)).toEqual(['origin', 'alpha', 'zed']);
  });

  it('ignores names it cannot split', () => {
    const branches: Loadable<Branch[]> = {
      state: 'ready',
      value: [branch({ name: 'headless', remote: true })],
    };
    expect(candidateRemotes(branches)).toEqual([]);
  });
});

describe('gates', () => {
  it('lets every action run on a healthy tracking branch', () => {
    expect(fetchBlock(gate())).toBeNull();
    expect(pullBlock(gate())).toBeNull();
    expect(pushBlock(gate())).toBeNull();
  });

  it('blocks everything while another operation is running', () => {
    const busy = gate({ busy: true });
    expect(fetchBlock(busy)).toMatch(/already running/);
    expect(pullBlock(busy)).toMatch(/already running/);
    expect(pushBlock(busy)).toMatch(/already running/);
  });

  it('blocks everything with no repository open', () => {
    const closed = gate({ repoOpen: false, statusState: 'idle' });
    expect(fetchBlock(closed)).toMatch(/No repository/);
    expect(pullBlock(closed)).toMatch(/No repository/);
    expect(pushBlock(closed)).toMatch(/No repository/);
  });

  it('blocks pull and push, but not fetch, while conflicts are unresolved', () => {
    const conflicted = gate({ hasConflicts: true });
    expect(fetchBlock(conflicted)).toBeNull();
    expect(pullBlock(conflicted)).toMatch(/merge is in progress/);
    expect(pushBlock(conflicted)).toMatch(/merge is in progress/);
  });

  it('blocks pull and push, but not fetch, on a detached HEAD', () => {
    const detached = gate({ upstream: { kind: 'detached' } });
    expect(fetchBlock(detached)).toBeNull();
    expect(pullBlock(detached)).toMatch(/detached/);
    expect(pushBlock(detached)).toMatch(/detached/);
  });

  it('blocks pull and push while the status is unread or failed', () => {
    for (const statusState of ['loading', 'error'] as const) {
      expect(pullBlock(gate({ statusState }))).not.toBeNull();
      expect(pushBlock(gate({ statusState }))).not.toBeNull();
    }
  });

  it('blocks pull on a branch with no upstream but allows publishing it', () => {
    const fresh = gate({ upstream: { kind: 'no-upstream', branch: 'topic' } });
    expect(pullBlock(fresh)).toMatch(/no upstream/);
    expect(pushBlock(fresh)).toBeNull();
  });

  it.each(['idle', 'loading'] as const)(
    'does not claim there is no remote while the branch list is %s',
    (branchesState) => {
      const reason = pushBlock(
        gate({
          upstream: { kind: 'no-upstream', branch: 'topic' },
          branchesState,
          publishRemote: null,
        }),
      );
      expect(reason).toMatch(/Reading the list of remotes/);
      expect(reason).not.toMatch(/git remote add/);
    },
  );

  it('says the branch list failed rather than blaming a missing remote', () => {
    const reason = pushBlock(
      gate({
        upstream: { kind: 'no-upstream', branch: 'topic' },
        branchesState: 'error',
        publishRemote: null,
      }),
    );
    expect(reason).toMatch(/could not be read/);
    expect(reason).not.toMatch(/git remote add/);
  });

  it('blocks publishing when no remote name is known', () => {
    const fresh = gate({
      upstream: { kind: 'no-upstream', branch: 'topic' },
      publishRemote: null,
    });
    expect(pushBlock(fresh)).toMatch(/no remote/i);
  });

  it('blocks push when the upstream branch has a different name', () => {
    const renamed = gate({
      upstream: {
        kind: 'tracking',
        branch: 'main',
        upstream: { remote: 'origin', branch: 'trunk' },
        ahead: 1,
        behind: 0,
      },
    });
    expect(pushBlock(renamed)).toContain('git push origin main:trunk');
  });

  it('blocks pull and push on an unreadable upstream', () => {
    const broken = gate({
      upstream: { kind: 'unreadable-upstream', branch: 'main', upstream: 'weird' },
    });
    expect(pullBlock(broken)).toContain('weird');
    expect(pushBlock(broken)).toContain('weird');
  });

  it('blocks push on an unborn branch', () => {
    const unborn = gate({ upstream: { kind: 'unborn', branch: 'main' } });
    expect(pullBlock(unborn)).toMatch(/no commits yet/);
    expect(pushBlock(unborn)).toMatch(/no commits yet/);
  });
});

describe('pushIntent', () => {
  it('pushes a tracking branch to its own remote without re-setting upstream', () => {
    expect(pushIntent(gate())).toEqual({ remote: 'origin', branch: 'main' });
  });

  it('publishes a branch with no upstream to the chosen remote', () => {
    expect(
      pushIntent(
        gate({
          upstream: { kind: 'no-upstream', branch: 'topic' },
          publishRemote: 'fork',
        }),
      ),
    ).toEqual({ remote: 'fork', branch: 'topic', setUpstream: true });
  });

  // Each of these is a case where the button is disabled. The intent has to
  // refuse on its own, so a click that reaches the handler cannot push anyway.
  it.each([
    ['busy', gate({ busy: true })],
    ['no repository', gate({ repoOpen: false, statusState: 'idle' })],
    ['unresolved conflicts', gate({ hasConflicts: true })],
    ['a detached HEAD', gate({ upstream: { kind: 'detached' } })],
    ['an unread status', gate({ statusState: 'loading' })],
    ['a failed status read', gate({ statusState: 'error' })],
    ['an unborn branch', gate({ upstream: { kind: 'unborn', branch: 'main' } })],
    [
      'an unreadable upstream',
      gate({
        upstream: { kind: 'unreadable-upstream', branch: 'main', upstream: 'weird' },
      }),
    ],
    [
      'a differently-named upstream',
      gate({
        upstream: {
          kind: 'tracking',
          branch: 'main',
          upstream: { remote: 'origin', branch: 'trunk' },
          ahead: 1,
          behind: 0,
        },
      }),
    ],
    [
      'no known remote to publish to',
      gate({
        upstream: { kind: 'no-upstream', branch: 'topic' },
        publishRemote: null,
      }),
    ],
    [
      'an unread branch list',
      gate({
        upstream: { kind: 'no-upstream', branch: 'topic' },
        branchesState: 'loading',
        publishRemote: null,
      }),
    ],
  ])('refuses to push with %s', (_case, blocked) => {
    expect(pushIntent(blocked)).toBeNull();
  });
});
