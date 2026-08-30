import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAbortCommand,
  buildContinueCommand,
  buildRefExistsCommand,
  buildSkipCommand,
  isContinuable,
} from './commands/operation';
import { userConfirmed } from './confirm';
import { isDestructive } from './destructive';
import { GitError } from './errors';
import {
  abortOperation,
  continueOperation,
  readOperation,
  skipOperation,
} from './operation';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const REPO = 'C:/repo';
const GIT_DIR = 'C:/repo/.git';
const OID = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const OK = 'the user was asked';

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

function noRebase() {
  return {
    in_progress: false,
    current: null,
    total: null,
    head_name: null,
    onto: null,
    interactive: false,
  };
}

/**
 * Answers as the app's two backends do: `rebase_state` for the counters, and
 * `git_run` for everything else, in call order.
 */
function respond(options: {
  rebase?: Record<string, unknown>;
  git?: Record<string, unknown>[];
}): void {
  const git = [...(options.git ?? [])];
  invoke.mockImplementation((command: string) => {
    if (command === 'rebase_state') {
      return Promise.resolve({ ...noRebase(), ...(options.rebase ?? {}) });
    }
    return Promise.resolve(raw(git.shift() ?? {}));
  });
}

/** Arguments of the nth `git_run`, ignoring the state probe. */
function gitArgs(): string[][] {
  return invoke.mock.calls
    .filter((call) => call[0] === 'git_run')
    .map((call) => call[1].args as string[]);
}

beforeEach(() => {
  invoke.mockReset();
});

describe('the builders', () => {
  it('asks whether a pseudo-ref resolves, quietly', () => {
    // `--verify --quiet` is what makes "absent" an exit code instead of noise
    // on stderr, so absence can be told from failure.
    expect(buildRefExistsCommand('MERGE_HEAD').args).toEqual([
      'rev-parse',
      '--verify',
      '--quiet',
      'MERGE_HEAD^{commit}',
    ]);
  });

  it('continues without letting git open an editor', () => {
    // Without this the command waits on an editor this process has no terminal
    // to host, and the app sits there mid-rebase until the timeout kills it.
    expect(buildContinueCommand('rebase').args).toEqual([
      '-c',
      'core.editor=true',
      'rebase',
      '--continue',
    ]);
  });

  it('continues a cherry-pick and a revert the same way', () => {
    expect(buildContinueCommand('cherry-pick').args).toContain('cherry-pick');
    expect(buildContinueCommand('revert').args).toContain('revert');
  });

  it('needs a confirmation for every way out', () => {
    // Each of these drops or replays commits. `-c core.editor=true` must not
    // hide the subcommand from the gate, which is why the deny-list skips
    // value-taking globals.
    expect(isDestructive(buildContinueCommand('rebase').args)).toBe(true);
    expect(isDestructive(buildSkipCommand('rebase').args)).toBe(true);
    expect(isDestructive(buildAbortCommand('merge').args)).toBe(true);
  });

  it('gives a replay of many commits room to finish', () => {
    expect(buildContinueCommand('rebase').timeoutMs).toBeGreaterThan(60_000);
  });

  it('knows a merge cannot be continued, only committed or aborted', () => {
    expect(isContinuable('rebase')).toBe(true);
    expect(isContinuable('merge')).toBe(false);
  });
});

describe('readOperation', () => {
  it('reports nothing in progress in an ordinary repository', async () => {
    respond({ git: [{ code: 1 }, { code: 1 }, { code: 1 }] });
    await expect(readOperation(REPO, GIT_DIR)).resolves.toMatchObject({ kind: null });
  });

  it('reports a rebase, with the step it is on and the branch', async () => {
    respond({
      rebase: {
        in_progress: true,
        current: 3,
        total: 43,
        head_name: 'feat/x',
        interactive: true,
      },
      git: [{ stdout: `${OID}\n` }, { stdout: '' }],
    });

    const operation = await readOperation(REPO, GIT_DIR);
    expect(operation).toMatchObject({
      kind: 'rebase',
      step: 3,
      steps: 43,
      branch: 'feat/x',
    });
    expect(operation.commit?.oid).toBe(OID);
  });

  it('calls a stopped rebase a rebase even though MERGE_HEAD is also there', async () => {
    // The original bug, in one test: the merge backend writes a MERGE_HEAD too,
    // so asking about merges first answers "merge" and offers `merge --abort`,
    // which fails with "MERGE_HEAD missing" and strands the user.
    respond({
      rebase: { in_progress: true, current: 1, total: 2 },
      git: [{ stdout: `${OID}\n` }, { stdout: '' }],
    });

    await expect(readOperation(REPO, GIT_DIR)).resolves.toMatchObject({
      kind: 'rebase',
    });
    expect(gitArgs()[0]?.[3]).toBe('REBASE_HEAD^{commit}');
  });

  it('still reports the rebase when git recorded no counters', async () => {
    respond({
      rebase: { in_progress: true },
      git: [{ stdout: `${OID}\n` }, { stdout: '' }],
    });
    await expect(readOperation(REPO, GIT_DIR)).resolves.toMatchObject({
      kind: 'rebase',
      step: null,
      steps: null,
    });
  });

  it('reports a cherry-pick and a revert as themselves', async () => {
    respond({ git: [{ stdout: `${OID}\n` }, { stdout: '' }] });
    await expect(readOperation(REPO, GIT_DIR)).resolves.toMatchObject({
      kind: 'cherry-pick',
    });

    invoke.mockReset();
    respond({ git: [{ code: 1 }, { stdout: `${OID}\n` }, { stdout: '' }] });
    await expect(readOperation(REPO, GIT_DIR)).resolves.toMatchObject({
      kind: 'revert',
    });
  });

  it('reports a plain merge when no other head is set', async () => {
    respond({ git: [{ code: 1 }, { code: 1 }, { stdout: `${OID}\n` }, { stdout: '' }] });
    await expect(readOperation(REPO, GIT_DIR)).resolves.toMatchObject({
      kind: 'merge',
    });
  });

  it('survives a rebase_state that cannot be read', async () => {
    // The counters are a courtesy; the refs still decide which commands may be
    // offered, and losing the whole answer would strand the user again.
    invoke.mockImplementation((command: string) =>
      command === 'rebase_state'
        ? Promise.reject(new Error('bad git directory'))
        : Promise.resolve(raw({ code: 1 })),
    );
    await expect(readOperation(REPO, GIT_DIR)).resolves.toMatchObject({ kind: null });
  });
});

describe('ending an operation', () => {
  it('continues, skips and aborts the operation it was told about', async () => {
    respond({ git: [{}] });
    await continueOperation(REPO, 'rebase', userConfirmed(OK));
    expect(gitArgs()[0]).toEqual(['-c', 'core.editor=true', 'rebase', '--continue']);

    invoke.mockReset();
    respond({ git: [{}] });
    await skipOperation(REPO, 'rebase', userConfirmed(OK));
    expect(gitArgs()[0]).toEqual(['rebase', '--skip']);

    invoke.mockReset();
    respond({ git: [{}] });
    await abortOperation(REPO, 'rebase', userConfirmed(OK));
    expect(gitArgs()[0]).toEqual(['rebase', '--abort']);
  });

  it('aborts a merge as a merge, which is the only case that ever worked', async () => {
    respond({ git: [{}] });
    await abortOperation(REPO, 'merge', userConfirmed(OK));
    expect(gitArgs()[0]).toEqual(['merge', '--abort']);
  });

  it('cannot be reached without a confirmation the user minted', () => {
    // Thrown before anything is spawned, not rejected afterwards: the gate is
    // the first thing these functions do.
    expect(() =>
      // @ts-expect-error — the point of the test: a bare object is not a token.
      abortOperation(REPO, 'rebase', { reason: '' }),
    ).toThrow(GitError);
    expect(invoke).not.toHaveBeenCalled();
  });
});
