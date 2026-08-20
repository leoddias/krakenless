import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cherryPick,
  createTag,
  currentBranch,
  rebaseOnto,
  resetTo,
  revertCommit,
} from './commits';
import { userConfirmed } from './confirm';
import { GitError } from './errors';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const OID = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const OK = { reason: 'the user was asked' };

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

/** Arguments of the nth git invocation. */
function argsOf(call: number): string[] {
  return invoke.mock.calls[call]?.[1].args as string[];
}

beforeEach(() => {
  invoke.mockReset();
});

describe('currentBranch', () => {
  it('reports the branch HEAD is on', async () => {
    respond({ stdout: 'main\n' });
    await expect(currentBranch('C:/repo')).resolves.toBe('main');
  });

  it('reads a detached HEAD as null rather than throwing', async () => {
    // `symbolic-ref --quiet` exits 1 with no output when HEAD is detached.
    respond({ stdout: '', code: 1 });
    await expect(currentBranch('C:/repo')).resolves.toBeNull();
  });
});

describe('createTag', () => {
  it('runs without a confirmation — creating a tag loses nothing', async () => {
    respond({});
    await createTag('C:/repo', 'v1.0', OID);
    expect(argsOf(0)).toEqual(['tag', 'v1.0', OID]);
  });

  it('passes an annotation through', async () => {
    respond({});
    await createTag('C:/repo', 'v1.0', OID, { message: 'ship it' });
    expect(argsOf(0)).toContain('--annotate');
  });
});

describe('cherryPick and revertCommit', () => {
  it('cherry-picks the named commit', async () => {
    respond({});
    await cherryPick('C:/repo', OID);
    expect(argsOf(0)).toEqual(['cherry-pick', OID]);
  });

  it('reverts without opening an editor', async () => {
    respond({});
    await revertCommit('C:/repo', OID);
    expect(argsOf(0)).toEqual(['revert', '--no-edit', OID]);
  });
});

describe('rebaseOnto', () => {
  it('rebases when HEAD is still on the branch the user was shown', async () => {
    respond({ stdout: 'main\n' }, {});
    await rebaseOnto('C:/repo', 'main', OID, userConfirmed(OK.reason));
    expect(argsOf(0)).toEqual(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    expect(argsOf(1)).toEqual(['rebase', OID]);
  });

  it('refuses, and runs nothing, when HEAD moved to another branch', async () => {
    respond({ stdout: 'release\n' });
    await expect(
      rebaseOnto('C:/repo', 'main', OID, userConfirmed(OK.reason)),
    ).rejects.toThrow(/no longer|now on "release"/);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('refuses when HEAD detached since the menu was drawn', async () => {
    respond({ stdout: '', code: 1 });
    await expect(
      rebaseOnto('C:/repo', 'main', OID, userConfirmed(OK.reason)),
    ).rejects.toThrow(/no longer on a branch/);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('cannot be reached without a confirmation the user minted', async () => {
    await expect(
      // @ts-expect-error — the point of the test: a bare object is not a token.
      rebaseOnto('C:/repo', 'main', OID, { reason: '' }),
    ).rejects.toThrow(GitError);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('resetTo', () => {
  it.each(['soft', 'mixed', 'hard'] as const)(
    'checks HEAD before a %s reset',
    async (mode) => {
      respond({ stdout: 'main\n' }, {});
      await resetTo('C:/repo', 'main', OID, mode, userConfirmed(OK.reason));
      expect(argsOf(1)).toEqual(['reset', `--${mode}`, OID]);
    },
  );

  it('refuses, and runs nothing, when HEAD moved', async () => {
    respond({ stdout: 'release\n' });
    await expect(
      resetTo('C:/repo', 'main', OID, 'hard', userConfirmed(OK.reason)),
    ).rejects.toThrow(/now on "release"/);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each(['soft', 'mixed', 'hard'] as const)(
    'refuses a %s reset with no confirmation at all',
    async (mode) => {
      await expect(
        // @ts-expect-error — a caller that never asked has no token to pass.
        resetTo('C:/repo', 'main', OID, mode, { reason: '' }),
      ).rejects.toThrow(GitError);
      expect(invoke).not.toHaveBeenCalled();
    },
  );
});
