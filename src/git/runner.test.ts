import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitError } from './errors';
import { runGit } from './runner';

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

describe('runGit', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('passes the argument array through untouched', async () => {
    invoke.mockResolvedValue(raw({ stdout: 'ok' }));
    const result = await runGit('C:/repo', { args: ['status', '--porcelain=v2'] });

    expect(invoke).toHaveBeenCalledWith('git_run', {
      repo: 'C:/repo',
      args: ['status', '--porcelain=v2'],
      timeoutMs: null,
      stdin: null,
    });
    expect(result.stdout).toBe('ok');
  });

  it('forwards a per-command timeout', async () => {
    invoke.mockResolvedValue(raw());
    await runGit('C:/repo', { args: ['fetch'], timeoutMs: 120_000 });
    expect(invoke).toHaveBeenCalledWith(
      'git_run',
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
  });

  it('refuses a destructive command without confirmation', async () => {
    await expect(
      runGit('C:/repo', { args: ['reset', '--hard'], destructive: true }),
    ).rejects.toMatchObject({ kind: 'needs-confirmation' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('runs a destructive command once confirmed', async () => {
    invoke.mockResolvedValue(raw());
    await runGit(
      'C:/repo',
      { args: ['reset', '--hard'], destructive: true },
      { confirmed: true },
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('throws on a non-zero exit code instead of returning it', async () => {
    invoke.mockResolvedValue(raw({ code: 128, stderr: 'fatal: not a git repository' }));
    await expect(runGit('C:/repo', { args: ['status'] })).rejects.toMatchObject({
      kind: 'not-a-repository',
    });
  });

  it('accepts exit codes the caller declared expected', async () => {
    invoke.mockResolvedValue(raw({ code: 1 }));
    const result = await runGit(
      'C:/repo',
      { args: ['diff', '--quiet'] },
      { allowExitCodes: [1] },
    );
    expect(result.code).toBe(1);
  });

  it('throws on a timeout even when the exit code is allowed', async () => {
    invoke.mockResolvedValue(raw({ code: 1, timed_out: true }));
    await expect(
      runGit('C:/repo', { args: ['fetch'] }, { allowExitCodes: [1] }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('maps a missing git binary to a readable error', async () => {
    invoke.mockRejectedValue({ kind: 'SpawnFailed', message: 'program not found' });
    const error = await runGit('C:/repo', { args: ['status'] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).kind).toBe('git-missing');
  });

  it.each([
    ['BadRepoPath', 'bad-repo-path'],
    ['BadArgument', 'bad-argument'],
    ['IoFailed', 'command-failed'],
  ])('maps runner error %s', async (kind, expected) => {
    invoke.mockRejectedValue({ kind, message: 'nope' });
    await expect(runGit('C:/repo', { args: ['status'] })).rejects.toMatchObject({
      kind: expected,
    });
  });

  it('passes stdin through for commands that read a patch', async () => {
    invoke.mockResolvedValue(raw());
    await runGit('C:/repo', { args: ['apply', '--cached', '-'] }, { stdin: 'PATCH' });
    expect(invoke).toHaveBeenCalledWith(
      'git_run',
      expect.objectContaining({ stdin: 'PATCH' }),
    );
  });

  it('gates a destructive command even when the builder forgot the flag', async () => {
    await expect(runGit('C:/repo', { args: ['clean', '-fd'] })).rejects.toMatchObject({
      kind: 'needs-confirmation',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('refuses undecodable output that could become a path', async () => {
    invoke.mockResolvedValue(raw({ stdout: 'caf�.txt', stdout_lossy: true }));
    await expect(runGit('C:/repo', { args: ['status'] })).rejects.toMatchObject({
      kind: 'undecodable-output',
    });
  });

  it('allows undecodable output when the caller opted in', async () => {
    invoke.mockResolvedValue(raw({ stdout: 'x', stdout_lossy: true }));
    await expect(
      runGit('C:/repo', { args: ['show', 'HEAD'] }, { allowLossyOutput: true }),
    ).resolves.toMatchObject({ stdoutLossy: true });
  });

  it('never accepts a killed process as an allowed exit code', async () => {
    invoke.mockResolvedValue(raw({ code: null }));
    await expect(
      runGit('C:/repo', { args: ['status'] }, { allowExitCodes: [-1] }),
    ).rejects.toMatchObject({ kind: 'command-failed' });
  });

  it('survives a rejection that is not a runner error', async () => {
    invoke.mockRejectedValue('exploded');
    await expect(runGit('C:/repo', { args: ['status'] })).rejects.toMatchObject({
      kind: 'command-failed',
    });
  });
});
