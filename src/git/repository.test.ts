import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitError } from './errors';
import { openRepository } from './repository';

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

/** Queues one response per git invocation, in call order. */
function respond(...responses: Record<string, unknown>[]) {
  for (const response of responses) {
    invoke.mockResolvedValueOnce(raw(response));
  }
}

describe('openRepository', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('describes a normal repository with commits', async () => {
    respond(
      { stdout: 'C:/repos/app/.git\nfalse\n' },
      { stdout: 'C:/repos/app\n' },
      { stdout: '9f1c2ab\n' },
    );

    await expect(openRepository('C:/repos/app')).resolves.toEqual({
      root: 'C:/repos/app',
      gitDir: 'C:/repos/app/.git',
      bare: false,
      empty: false,
    });
  });

  it('marks a repository with no commits as empty', async () => {
    respond(
      { stdout: 'C:/repos/new/.git\nfalse\n' },
      { stdout: 'C:/repos/new\n' },
      {
        stdout: '',
        code: 1,
      },
    );

    await expect(openRepository('C:/repos/new')).resolves.toMatchObject({ empty: true });
  });

  it('does not ask for a worktree root in a bare repository', async () => {
    respond({ stdout: '/srv/app.git\ntrue\n' }, { stdout: 'deadbeef\n' });

    await expect(openRepository('/srv/app.git')).resolves.toEqual({
      root: '/srv/app.git',
      gitDir: '/srv/app.git',
      bare: true,
      empty: false,
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('reports a non-repository instead of inventing one', async () => {
    respond({ code: 128, stderr: 'fatal: not a git repository (or any parent up to /)' });
    await expect(openRepository('C:/tmp')).rejects.toMatchObject({
      kind: 'not-a-repository',
    });
  });

  it('propagates a timeout rather than calling the repository empty', async () => {
    respond(
      { stdout: 'C:/repos/big/.git\nfalse\n' },
      { stdout: 'C:/repos/big\n' },
      { code: null, timed_out: true },
    );

    const error = await openRepository('C:/repos/big').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).kind).toBe('timeout');
  });

  it('propagates a missing git binary', async () => {
    invoke.mockRejectedValueOnce({ kind: 'SpawnFailed', message: 'not found' });
    await expect(openRepository('C:/repos/app')).rejects.toMatchObject({
      kind: 'git-missing',
    });
  });

  it('treats git ambiguous-HEAD wording as an empty repository', async () => {
    respond({ stdout: 'C:/repos/new/.git\nfalse\n' }, { stdout: 'C:/repos/new\n' });
    invoke.mockResolvedValueOnce(
      raw({ code: 128, stderr: "fatal: ambiguous argument 'HEAD': unknown revision" }),
    );

    await expect(openRepository('C:/repos/new')).resolves.toMatchObject({ empty: true });
  });
});
