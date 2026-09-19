import { describe, expect, it } from 'vitest';
import { refPath, shortRefName } from './refName';

describe('refPath', () => {
  it('puts each kind of ref under the namespace git keeps it in', () => {
    expect(refPath('branch', 'main')).toBe('refs/heads/main');
    expect(refPath('remote-branch', 'origin/main')).toBe('refs/remotes/origin/main');
    expect(refPath('tag', 'v1.0')).toBe('refs/tags/v1.0');
  });

  it('tells apart three refs whose short names are identical', () => {
    // Git allows all three at once. The short name cannot say which one a
    // click was about; the path can, and a delete offered against the wrong
    // one of these is the mistake the panels must not make.
    const paths = new Set([
      refPath('branch', 'release'),
      refPath('remote-branch', 'origin/release'),
      refPath('tag', 'release'),
    ]);
    expect(paths.size).toBe(3);
  });

  it('leaves HEAD alone, which is not under refs/', () => {
    expect(refPath('head', 'HEAD')).toBe('HEAD');
  });

  it('keeps the slashes inside a name, which are part of it', () => {
    expect(refPath('branch', 'feat/ui/tabs')).toBe('refs/heads/feat/ui/tabs');
  });
});

describe('shortRefName', () => {
  it('is the inverse of refPath for every kind the panels list', () => {
    for (const [kind, name] of [
      ['branch', 'feat/ui/tabs'],
      ['remote-branch', 'origin/feat/x'],
      ['tag', 'release/1.0'],
    ] as const) {
      expect(shortRefName(refPath(kind, name))).toBe(name);
    }
  });

  it('keeps the remote on a remote-tracking name, which is part of it', () => {
    // The remote list shows `origin/feat/x` and groups by that first segment.
    expect(shortRefName('refs/remotes/origin/feat/x')).toBe('origin/feat/x');
  });

  it('leaves anything that is not one of the three namespaces alone', () => {
    expect(shortRefName('HEAD')).toBe('HEAD');
    expect(shortRefName('refs/stash')).toBe('refs/stash');
  });
});
