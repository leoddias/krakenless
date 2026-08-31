import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitError } from '../git/errors';
import { MAX_PATCH_CHARS } from './commands/message';
import { generateCommitMessage } from './message';

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

const PATCH = 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-one\n+two\n';

/** The arguments of the nth call, whichever command it was. */
function callArgs(n: number): Record<string, unknown> {
  return invoke.mock.calls[n]?.[1] as Record<string, unknown>;
}

/** The single `ai_run` call, which is always the last one. */
function aiCall(): Record<string, unknown> {
  const index = invoke.mock.calls.findIndex((call) => call[0] === 'ai_run');
  return callArgs(index);
}

beforeEach(() => {
  invoke.mockReset();
  // git diff --cached, then ai_run.
  invoke
    .mockResolvedValueOnce(raw({ stdout: PATCH }))
    .mockResolvedValueOnce(raw({ stdout: 'feat: swap one for two\n' }));
});

describe('generateCommitMessage', () => {
  it('feeds the staged patch on stdin, not in the arguments', async () => {
    const result = await generateCommitMessage('C:/repo', 'claude', 'haiku');

    expect(result).toEqual({ message: 'feat: swap one for two', kind: 'patch' });
    expect(aiCall()['stdinText']).toBe(PATCH);
    expect(JSON.stringify(aiCall()['args'])).not.toContain('diff --git');
  });

  it('runs the configured program in the repository', async () => {
    await generateCommitMessage('C:/repo', 'my-llm', 'haiku');

    expect(aiCall()['program']).toBe('my-llm');
    expect(aiCall()['cwd']).toBe('C:/repo');
  });

  it('refuses when nothing is staged, without running the CLI', async () => {
    invoke.mockReset();
    invoke.mockResolvedValueOnce(raw({ stdout: '' }));

    await expect(generateCommitMessage('C:/repo', 'claude', 'haiku')).rejects.toThrow(
      /nothing is staged/i,
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('sends a file summary when the patch is too large, and says so', async () => {
    // Not a truncated patch: that would produce a confident message about
    // whichever files happened to come first.
    invoke.mockReset();
    invoke
      .mockResolvedValueOnce(raw({ stdout: 'x'.repeat(MAX_PATCH_CHARS + 1) }))
      .mockResolvedValueOnce(raw({ stdout: ' a.ts | 2 +-\n 1 file changed\n' }))
      .mockResolvedValueOnce(raw({ stdout: 'chore: update a.ts\n' }));

    const result = await generateCommitMessage('C:/repo', 'claude', 'haiku');

    expect(result.kind).toBe('summary');
    expect(callArgs(1)['args']).toContain('--stat');
    expect(aiCall()['stdinText']).toContain('1 file changed');
  });

  it('explains a missing program instead of reporting a raw spawn failure', async () => {
    invoke.mockReset();
    invoke
      .mockResolvedValueOnce(raw({ stdout: PATCH }))
      .mockRejectedValueOnce({ kind: 'SpawnFailed', message: 'not found' });

    await expect(generateCommitMessage('C:/repo', 'claude', 'haiku')).rejects.toThrow(
      /Could not start "claude".*Settings/s,
    );
  });

  it('surfaces the CLI first stderr line, which is what says why', async () => {
    // "not logged in" and "unknown model" both arrive this way.
    invoke.mockReset();
    invoke
      .mockResolvedValueOnce(raw({ stdout: PATCH }))
      .mockResolvedValueOnce(raw({ code: 1, stderr: 'Invalid API key\nrun /login\n' }));

    await expect(generateCommitMessage('C:/repo', 'claude', 'haiku')).rejects.toThrow(
      /Invalid API key/,
    );
  });

  it('says nothing was changed when the CLI times out', async () => {
    invoke.mockReset();
    invoke
      .mockResolvedValueOnce(raw({ stdout: PATCH }))
      .mockResolvedValueOnce(raw({ timed_out: true }));

    await expect(generateCommitMessage('C:/repo', 'claude', 'haiku')).rejects.toThrow(
      /did not answer in time.*Nothing was changed/,
    );
  });

  it('rejects an empty answer rather than clearing the message box', async () => {
    invoke.mockReset();
    invoke
      .mockResolvedValueOnce(raw({ stdout: PATCH }))
      .mockResolvedValueOnce(raw({ stdout: '\n```\n```\n' }));

    await expect(generateCommitMessage('C:/repo', 'claude', 'haiku')).rejects.toThrow(
      GitError,
    );
  });
});
