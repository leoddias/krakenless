import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cherryPick,
  createTag,
  currentBranch,
  mergeInto,
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

describe('mergeInto', () => {
  it('merges into the branch the question named, once HEAD is confirmed', async () => {
    respond({ stdout: 'main\n' }, { stdout: 'Fast-forward\n' });
    await expect(
      mergeInto('C:/repo', 'main', 'feature/x', userConfirmed(OK.reason)),
    ).resolves.toBe('merged');
    expect(argsOf(0)).toEqual(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    expect(argsOf(1)).toEqual(['merge', '--no-edit', 'feature/x']);
  });

  it('refuses, and merges nothing, when HEAD moved to another branch', async () => {
    // Git merges into whatever is checked out now. A checkout between the
    // question and the answer would merge into a branch nobody was asked about.
    respond({ stdout: 'release\n' });
    await expect(
      mergeInto('C:/repo', 'main', 'feature/x', userConfirmed(OK.reason)),
    ).rejects.toThrow(/now on "release"/);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('refuses when HEAD detached since the question was asked', async () => {
    respond({ stdout: '', code: 1 });
    await expect(
      mergeInto('C:/repo', 'main', 'feature/x', userConfirmed(OK.reason)),
    ).rejects.toThrow(/no longer on a branch/);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('reports a conflict as an outcome, not as a failure', async () => {
    // Git stopped where it always stops; the repository is mid-merge and the
    // conflict panel is where the job is finished.
    respond(
      { stdout: 'main\n' },
      {
        stdout: 'CONFLICT (content): Merge conflict in src/app.ts\n',
        stderr: 'Automatic merge failed; fix conflicts and then commit the result.\n',
        code: 1,
      },
    );
    await expect(
      mergeInto('C:/repo', 'main', 'feature/x', userConfirmed(OK.reason)),
    ).resolves.toBe('conflicted');
  });

  it('still fails for a refusal that is not a conflict, in git\u2019s own words', async () => {
    respond(
      { stdout: 'main\n' },
      {
        stdout: '',
        stderr:
          'error: Your local changes to the following files would be overwritten by merge:\n\tsrc/app.ts\n',
        code: 1,
      },
    );
    await expect(
      mergeInto('C:/repo', 'main', 'feature/x', userConfirmed(OK.reason)),
    ).rejects.toThrow(/local changes .* would be overwritten/);
  });

  it('cannot be reached without a confirmation the user minted', async () => {
    await expect(
      // @ts-expect-error — the point of the test: a bare object is not a token.
      mergeInto('C:/repo', 'main', 'feature/x', { reason: '' }),
    ).rejects.toThrow(GitError);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('rebaseOnto', () => {
  it('rebases when HEAD is still on the branch the user was shown', async () => {
    respond({ stdout: 'main\n' }, {});
    await rebaseOnto('C:/repo', 'main', OID, userConfirmed(OK.reason));
    expect(argsOf(0)).toEqual(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    expect(argsOf(1)).toEqual(['rebase', '--autostash', OID]);
  });

  it('reports an autostash git could not put back, which it exits 0 for', async () => {
    // The worst shape a rebase can end in: git says "Successfully rebased",
    // exits 0, and leaves conflict markers in files the user never touched in
    // the replay, with their work in a stash nobody mentioned.
    respond(
      { stdout: 'main\n' },
      {
        stdout:
          'Applying autostash resulted in conflicts.\nYour changes are safe in the stash.\nSuccessfully rebased and updated refs/heads/main.\n',
      },
    );

    await expect(
      rebaseOnto('C:/repo', 'main', OID, userConfirmed(OK.reason)),
    ).resolves.toBe('autostash-conflicted');
  });

  it('recognises the older wording git wraps across three lines', async () => {
    // What GitHub's Windows runner prints. Matching only the modern sentence
    // is a warning that never fires for half the gits in the world.
    respond(
      { stdout: 'main\n' },
      {
        stderr:
          'Created autostash: f35954d\nRebasing (1/1)Your local changes are stashed, however applying them\nresulted in conflicts.  You can either resolve the conflicts\nand then discard the stash with "git stash drop".\nSuccessfully rebased and updated refs/heads/main.\n',
      },
    );

    await expect(
      rebaseOnto('C:/repo', 'main', OID, userConfirmed(OK.reason)),
    ).resolves.toBe('autostash-conflicted');
  });

  it('reports an ordinary rebase as rebased', async () => {
    respond(
      { stdout: 'main\n' },
      { stdout: 'Successfully rebased and updated refs/heads/main.\n' },
    );

    await expect(
      rebaseOnto('C:/repo', 'main', OID, userConfirmed(OK.reason)),
    ).resolves.toBe('rebased');
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
