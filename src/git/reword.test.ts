import { beforeEach, describe, expect, it, vi } from 'vitest';
import { userConfirmed } from './confirm';
import { GitError } from './errors';
import { rewordHead } from './stage';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const OID = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const OTHER = 'f'.repeat(40);
const TREE = 'b'.repeat(40);
const REASON = 'Rewrite the message of a1b2c3d';

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
  for (const response of responses) invoke.mockResolvedValueOnce(raw(response));
}

function argsOf(call: number): string[] {
  return invoke.mock.calls[call]?.[1].args as string[];
}

function ran(subcommand: string): boolean {
  return invoke.mock.calls.some((call) => (call[1].args as string[])[0] === subcommand);
}

beforeEach(() => {
  invoke.mockReset();
});

describe('rewordHead', () => {
  it('checks HEAD and its branch, then amends only the message', async () => {
    respond(
      { stdout: `${OID}\n` },
      { stdout: 'main\n' },
      { stdout: `${TREE}\n` },
      {},
      { stdout: `${TREE}\n` },
    );

    await rewordHead('C:/repo', OID, 'main', 'fix: typo', userConfirmed(REASON));

    expect(argsOf(0)).toEqual(['rev-parse', '--verify', '--quiet', 'HEAD']);
    expect(argsOf(1)).toEqual(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    expect(argsOf(2)).toEqual(['rev-parse', '--verify', '--quiet', `${OID}^{tree}`]);
    expect(argsOf(3)).toEqual([
      'commit',
      '--amend',
      '--only',
      '--allow-empty',
      '--message',
      'fix: typo',
    ]);
    expect(invoke).toHaveBeenCalledTimes(5);
  });

  it('refuses, and amends nothing, when HEAD moved to another commit', async () => {
    respond({ stdout: `${OTHER}\n` });
    await expect(
      rewordHead('C:/repo', OID, 'main', 'x', userConfirmed(REASON)),
    ).rejects.toThrow(/HEAD moved to fffffff/);
    expect(ran('commit')).toBe(false);
  });

  it('refuses when there is no commit at all any more', async () => {
    respond({ stdout: '', code: 1 });
    await expect(
      rewordHead('C:/repo', OID, 'main', 'x', userConfirmed(REASON)),
    ).rejects.toThrow(GitError);
    expect(ran('commit')).toBe(false);
  });

  it('refuses when another branch on the same commit is now checked out', async () => {
    // Same oid, different branch: amending would move the branch nobody named.
    respond({ stdout: `${OID}\n` }, { stdout: 'release\n' });
    await expect(
      rewordHead('C:/repo', OID, 'main', 'x', userConfirmed(REASON)),
    ).rejects.toThrow(/on "release"/);
    expect(ran('commit')).toBe(false);
  });

  it('refuses when HEAD detached since, and the other way round', async () => {
    respond({ stdout: `${OID}\n` }, { stdout: '', code: 1 });
    await expect(
      rewordHead('C:/repo', OID, 'main', 'x', userConfirmed(REASON)),
    ).rejects.toThrow(/now detached/);

    respond({ stdout: `${OID}\n` }, { stdout: 'main\n' });
    await expect(
      rewordHead('C:/repo', OID, null, 'x', userConfirmed(REASON)),
    ).rejects.toThrow(/on "main"/);
    expect(ran('commit')).toBe(false);
  });

  it('puts the commit back when a hook changed its tree', async () => {
    respond(
      { stdout: `${OID}\n` },
      { stdout: 'main\n' },
      { stdout: `${TREE}\n` },
      {},
      { stdout: `${'c'.repeat(40)}\n` },
      {},
    );

    await expect(
      rewordHead('C:/repo', OID, 'main', 'x', userConfirmed(REASON)),
    ).rejects.toThrow(/pre-commit hook changed files/);
    expect(argsOf(5)).toEqual(['reset', '--soft', OID]);
  });

  it('refuses a token with no reason before running anything', async () => {
    const forged = { ...userConfirmed(REASON), reason: '' };
    await expect(rewordHead('C:/repo', OID, 'main', 'x', forged)).rejects.toThrow(
      /missing its reason/,
    );
    expect(invoke).not.toHaveBeenCalled();
  });
});
