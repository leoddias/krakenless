import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteBranch, listStashes, pull, push, pushTag } from './refs';
import { userConfirmed } from './confirm';
import { GitError } from './errors';
import {
  buildFetchCommand,
  buildPullCommand,
  buildPushCommand,
  buildPushTagCommand,
} from './commands/remote';

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

  it('lets tags come with the history they point into', () => {
    // `--no-tags` was here, and it made every tag anyone else pushed invisible
    // in this app forever. Git's default follows a tag whose commit arrives and
    // leaves the rest alone, which is the honest middle between nothing and
    // `--tags` dragging down thousands of old refs.
    const args = buildFetchCommand({ prune: true }).args;
    expect(args).toEqual(['fetch', '--progress', '--prune', '--no-prune-tags', '--all']);
    expect(args).not.toContain('--no-tags');
    expect(args).not.toContain('--tags');
  });

  it('refuses to prune tags even when the user configured it', () => {
    // `fetch.pruneTags=true` turns a plain `--prune` into a tag deleter, and a
    // tag made here and never pushed is one the remote has never heard of. The
    // flag has to be stated, not assumed.
    expect(buildFetchCommand({ prune: true }).args).toContain('--no-prune-tags');
    expect(buildFetchCommand({ prune: true }).args).not.toContain('--prune-tags');
  });

  it('fetches one named remote when asked, and all of them otherwise', () => {
    expect(buildFetchCommand({ remote: 'origin' }).args).toEqual([
      'fetch',
      '--progress',
      'origin',
    ]);
    expect(buildFetchCommand().args).toContain('--all');
  });

  it('gives network commands a longer timeout than local ones', () => {
    expect(buildFetchCommand().timeoutMs).toBeGreaterThan(60_000);
    expect(buildPullCommand().timeoutMs).toBeGreaterThan(60_000);
  });

  it('pushes a tag by its fully qualified name, and never forces it', () => {
    // `git push` carries no tags with it, so a tag lives here only until it is
    // pushed by name. Qualified on both sides for the reason the branch push
    // is: a tag named `+v1.0` would otherwise be read as a force refspec.
    const command = buildPushTagCommand('origin', 'v1.0');
    expect(command.args).toEqual([
      'push',
      '--progress',
      'origin',
      'refs/tags/v1.0:refs/tags/v1.0',
    ]);
    expect(command.args).not.toContain('--force');
    expect(command.destructive).toBeFalsy();
    expect(command.timeoutMs).toBeGreaterThan(60_000);
  });

  it('validates the tag and remote a push names', () => {
    expect(() => buildPushTagCommand('origin', '+v1.0')).toThrow(GitError);
    expect(() => buildPushTagCommand('--upload-pack=evil', 'v1.0')).toThrow(GitError);
  });

  it('validates remote and branch names', () => {
    expect(() => buildPushCommand({ remote: '--exec=evil', branch: 'main' })).toThrow(
      GitError,
    );
    expect(() => buildFetchCommand({ remote: '--all-of-them; rm' })).toThrow(GitError);
  });
});

describe('pull', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

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
  beforeEach(() => {
    invoke.mockReset();
  });

  it('refuses a force push that nobody confirmed', async () => {
    // This is the one operation here that can destroy other people's work.
    invoke.mockResolvedValue(raw());
    await expect(
      push('C:/repo', { remote: 'origin', branch: 'main', forceWithLease: true }),
    ).rejects.toMatchObject({ kind: 'needs-confirmation' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('runs a force push once the user has confirmed', async () => {
    invoke.mockResolvedValue(raw());
    await push(
      'C:/repo',
      { remote: 'origin', branch: 'main', forceWithLease: true },
      userConfirmed('Force push main over origin?'),
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('needs no confirmation for an ordinary push', async () => {
    invoke.mockResolvedValue(raw());
    await push('C:/repo', { remote: 'origin', branch: 'main' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('deleteBranch', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

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
  beforeEach(() => {
    invoke.mockReset();
  });

  it('parses the NUL-framed list', async () => {
    const NUL = '\u0000';
    invoke.mockResolvedValue(
      raw({
        stdout: `stash@{0}${NUL}1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d${NUL}2026-08-20T01:00:00-03:00${NUL}On main: wip${NUL}`,
      }),
    );
    await expect(listStashes('C:/repo')).resolves.toEqual([
      {
        ref: 'stash@{0}',
        oid: '1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d',
        index: 0,
        message: 'On main: wip',
        branch: 'main',
        date: '2026-08-20T01:00:00-03:00',
      },
    ]);
  });
});

describe('pushTag', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('runs the push without needing a confirmation — it only ever adds a ref', () => {
    invoke.mockResolvedValue(raw({}));
    return pushTag('C:/repo', 'origin', 'v1.0').then(() => {
      expect(invoke.mock.calls[0]?.[1].args).toEqual([
        'push',
        '--progress',
        'origin',
        'refs/tags/v1.0:refs/tags/v1.0',
      ]);
    });
  });

  it('lets git’s refusal through when the remote already has that tag', async () => {
    invoke.mockResolvedValue(
      raw({
        code: 1,
        stderr: '! [rejected] v1.0 -> v1.0 (already exists)\n',
      }),
    );
    await expect(pushTag('C:/repo', 'origin', 'v1.0')).rejects.toThrow(GitError);
  });
});
