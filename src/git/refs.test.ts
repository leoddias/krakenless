import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteBranch, listStashes, pull, push } from './refs';
import { userConfirmed } from './confirm';
import { GitError } from './errors';
import { buildFetchCommand, buildPullCommand, buildPushCommand } from './commands/remote';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

function raw(overrides: Record<string, unknown> = {}) {
  return {
    stdout: '',
    stderr: '',
    code: 0,
    timed_out: false,
    stdout_lossy: false,
    ...overrides,
  };
}

describe('network builders', () => {
  it('never offers a plain force push', () => {
    // --force-with-lease refuses when the remote moved; --force does not, and
    // that difference is someone else's commits.
    const args = buildPushCommand({
      remote: 'origin',
      branch: 'main',
      forceWithLease: true,
    }).args;
    expect(args).toContain('--force-with-lease');
    expect(args).not.toContain('--force');
  });

  it('marks a lease push destructive but a normal push not', () => {
    expect(
      buildPushCommand({ remote: 'origin', branch: 'main' }).destructive,
    ).toBeFalsy();
    expect(
      buildPushCommand({ remote: 'origin', branch: 'main', forceWithLease: true })
        .destructive,
    ).toBe(true);
  });

  it('pulls fast-forward only, so no merge happens behind the user', () => {
    expect(buildPullCommand().args).toContain('--ff-only');
  });

  it('gives network commands a longer timeout than local ones', () => {
    expect(buildFetchCommand().timeoutMs).toBeGreaterThan(60_000);
    expect(buildPullCommand().timeoutMs).toBeGreaterThan(60_000);
  });

  it('validates remote and branch names', () => {
    expect(() => buildPushCommand({ remote: '--exec=evil', branch: 'main' })).toThrow(
      GitError,
    );
    expect(() => buildFetchCommand({ remote: '--all-of-them; rm' })).toThrow(GitError);
  });
});

describe('pull', () => {
  beforeEach(() => invoke.mockReset());

  it('explains divergence instead of leaving the raw git error', () => {
    invoke.mockResolvedValue(
      raw({
        code: 128,
        stderr: 'fatal: Not possible to fast-forward, aborting.',
      }),
    );
    return expect(pull('C:/repo')).rejects.toThrow(/diverged/i);
  });

  it('passes other failures through untouched', async () => {
    invoke.mockResolvedValue(raw({ code: 128, stderr: 'fatal: Authentication failed' }));
    await expect(pull('C:/repo')).rejects.toMatchObject({ kind: 'authentication' });
  });
});

describe('push', () => {
  beforeEach(() => invoke.mockReset());

  it('sends the confirmation the runner requires for a lease push', async () => {
    invoke.mockResolvedValue(raw());
    await push('C:/repo', { remote: 'origin', branch: 'main', forceWithLease: true });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('deleteBranch', () => {
  beforeEach(() => invoke.mockReset());

  it('deletes with the safe form first', async () => {
    invoke.mockResolvedValue(raw());
    await expect(
      deleteBranch('C:/repo', 'topic', userConfirmed('delete branch topic')),
    ).resolves.toEqual({ deleted: true });
    expect(invoke).toHaveBeenCalledWith(
      'git_run',
      expect.objectContaining({ args: ['branch', '-d', 'topic'] }),
    );
  });

  it('reports an unmerged branch instead of silently forcing', async () => {
    // Retrying with -D here would drop commits the user never saw a warning for.
    invoke.mockResolvedValue(
      raw({ code: 1, stderr: "error: the branch 'topic' is not fully merged" }),
    );

    const outcome = await deleteBranch('C:/repo', 'topic', userConfirmed('delete topic'));
    expect(outcome.deleted).toBe(false);
    expect(outcome.unmergedWarning).toContain('not merged');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('forces only when explicitly asked', async () => {
    invoke.mockResolvedValue(raw());
    await deleteBranch('C:/repo', 'topic', userConfirmed('force delete topic'), {
      force: true,
    });
    expect(invoke).toHaveBeenCalledWith(
      'git_run',
      expect.objectContaining({ args: ['branch', '-D', 'topic'] }),
    );
  });

  it('propagates an unrelated failure', async () => {
    invoke.mockResolvedValue(raw({ code: 1, stderr: "error: branch 'topic' not found" }));
    await expect(
      deleteBranch('C:/repo', 'topic', userConfirmed('delete topic')),
    ).rejects.toThrow(GitError);
  });
});

describe('listStashes', () => {
  beforeEach(() => invoke.mockReset());

  it('parses the NUL-framed list', async () => {
    const NUL = '\u0000';
    invoke.mockResolvedValue(
      raw({
        stdout: `stash@{0}${NUL}abc${NUL}2026-08-20T01:00:00-03:00${NUL}On main: wip${NUL}`,
      }),
    );
    await expect(listStashes('C:/repo')).resolves.toEqual([
      {
        ref: 'stash@{0}',
        oid: 'abc',
        index: 0,
        message: 'On main: wip',
        branch: 'main',
        date: '2026-08-20T01:00:00-03:00',
      },
    ]);
  });
});
