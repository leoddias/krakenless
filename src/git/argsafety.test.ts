import { describe, expect, it } from 'vitest';
import { assertPath, assertRefName, assertRevision, pathspec } from './argsafety';
import { GitError } from './errors';

describe('pathspec', () => {
  it('puts paths after the separator', () => {
    expect(pathspec(['src/app.ts', 'README.md'])).toEqual([
      '--',
      'src/app.ts',
      'README.md',
    ]);
  });

  it('refuses an empty list, which would mean "all paths"', () => {
    // A discard built from an empty selection must fail, not widen to the
    // whole worktree.
    expect(() => pathspec([])).toThrow(GitError);
  });

  it('keeps a path that looks like a flag, since it travels after --', () => {
    expect(pathspec(['--force'])).toEqual(['--', '--force']);
  });
});

describe('assertPath', () => {
  it.each(['src/app.ts', 'a b/c.txt', 'café.txt', 'dir/-weird.txt'])(
    'accepts %s',
    (path) => {
      expect(assertPath(path)).toBe(path);
    },
  );

  it.each([
    ['', 'empty'],
    ['C:/other/repo/file.txt', 'absolute Windows'],
    ['/etc/passwd', 'absolute POSIX'],
    ['../outside.txt', 'parent escape'],
    ['src/../../outside.txt', 'nested escape'],
    ['bad\0path', 'NUL'],
  ])('rejects %j (%s)', (path) => {
    expect(() => assertPath(path)).toThrow(GitError);
  });
});

describe('assertRefName', () => {
  it.each(['main', 'feature/login', 'release-1.2', 'v1.0.0'])('accepts %s', (name) => {
    expect(assertRefName(name)).toBe(name);
  });

  it.each([
    '--force',
    '-D',
    '',
    'has space',
    'has~tilde',
    'has^caret',
    'has:colon',
    'has?question',
    'star*',
    'back\\slash',
    'double..dot',
    'reflog@{0}',
    'trailing.',
    'trailing/',
    'branch.lock',
    '/leading',
    'double//slash',
    '@',
  ])('rejects %j', (name) => {
    expect(() => assertRefName(name)).toThrow(GitError);
  });

  it('reports the offending value in the error', () => {
    const error = (() => {
      try {
        assertRefName('--force');
      } catch (e) {
        return e as GitError;
      }
      return null;
    })();
    expect(error?.kind).toBe('bad-argument');
    expect(error?.message).toContain('--force');
  });
});

describe('assertRevision', () => {
  it.each(['HEAD', 'HEAD~1', 'HEAD^2', 'origin/main', '9f1c2ab', 'stash@{0}'])(
    'accepts %s',
    (rev) => {
      expect(assertRevision(rev)).toBe(rev);
    },
  );

  it.each(['', '-1', '--all', 'two words', 'nul\0'])('rejects %j', (rev) => {
    expect(() => assertRevision(rev)).toThrow(GitError);
  });
});
