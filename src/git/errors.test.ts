import { describe, expect, it } from 'vitest';
import { GitError, classifyFailure } from './errors';
import type { GitOutput } from './types';

function output(overrides: Partial<GitOutput> = {}): GitOutput {
  return {
    stdout: '',
    stderr: '',
    code: 1,
    timedOut: false,
    stdoutLossy: false,
    ...overrides,
  };
}

describe('classifyFailure', () => {
  it('reports a timeout before looking at stderr', () => {
    const error = classifyFailure(['fetch'], output({ timedOut: true, code: null }));
    expect(error.kind).toBe('timeout');
    expect(error.message).toContain('fetch');
  });

  it('detects a non-repository', () => {
    const error = classifyFailure(
      ['status'],
      output({
        stderr: 'fatal: not a git repository (or any of the parent directories): .git',
      }),
    );
    expect(error.kind).toBe('not-a-repository');
  });

  it.each([
    'fatal: Authentication failed for https://example.com/repo.git/',
    "fatal: could not read Username for 'https://example.com': terminal prompts disabled",
    'git@example.com: Permission denied (publickey).',
  ])('detects an auth failure in %s', (stderr) => {
    expect(classifyFailure(['push'], output({ stderr })).kind).toBe('authentication');
  });

  it.each([
    'CONFLICT (content): Merge conflict in src/app.ts',
    'error: Your local changes ... you have unmerged files',
    'Automatic merge failed; fix conflicts and then commit the result.',
    'error: could not apply 1a2b3c4... topic commit',
  ])('detects a real conflict in %s', (stderr) => {
    expect(classifyFailure(['merge', 'topic'], output({ stderr })).kind).toBe('conflict');
  });

  it('sees a conflict git announced on stdout', () => {
    // `git stash pop` and `git merge` print CONFLICT to stdout; reading only
    // stderr reported those as an anonymous "git failed with code 1".
    const error = classifyFailure(
      ['stash', 'pop'],
      output({
        code: 1,
        stdout: 'CONFLICT (content): Merge conflict in src/app.ts',
        stderr: '',
      }),
    );
    expect(error.kind).toBe('conflict');
  });

  it('does not call a missing branch a conflict', () => {
    // A bare substring match on "conflict" would send the UI into merge
    // recovery for a repository with no merge in progress.
    const error = classifyFailure(
      ['checkout', 'conflict-fix'],
      output({
        stderr: "error: pathspec 'conflict-fix' did not match any file(s) known to git",
      }),
    );
    expect(error.kind).toBe('command-failed');
  });

  it('does not call a branch named after auth an auth failure', () => {
    const error = classifyFailure(
      ['checkout', 'authentication-failed-fix'],
      output({ stderr: "error: pathspec 'authentication-failed-fix' did not match" }),
    );
    expect(error.kind).toBe('command-failed');
  });

  it('falls back to the first stderr line', () => {
    const error = classifyFailure(
      ['checkout', 'nope'],
      output({ stderr: "error: pathspec 'nope' did not match\nsecond line" }),
    );
    expect(error.kind).toBe('command-failed');
    expect(error.message).toBe("error: pathspec 'nope' did not match");
  });

  it('never loses the exit code, args or stderr', () => {
    const error = classifyFailure(['log'], output({ code: 128, stderr: 'boom' }));
    expect(error).toBeInstanceOf(GitError);
    expect(error.code).toBe(128);
    expect(error.args).toEqual(['log']);
    expect(error.stderr).toBe('boom');
  });

  it('describes an empty stderr by its exit code', () => {
    expect(classifyFailure(['x'], output({ code: 3 })).message).toBe(
      'git failed with code 3',
    );
  });
});
