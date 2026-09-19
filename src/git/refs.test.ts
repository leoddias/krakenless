import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteBranch,
  deleteRemoteBranch,
  deleteRemoteTag,
  deleteTag,
  listStashes,
  listTags,
  pull,
  pullMerge,
  push,
  pushTag,
} from './refs';
import { userConfirmed } from './confirm';
import { GitError } from './errors';
import { isDestructive } from './destructive';
import {
  buildDeleteRemoteBranchCommand,
  buildFetchCommand,
  buildPullCommand,
  buildPullMergeCommand,
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

/** A full oid, the only shape a lease is allowed to carry. */
const OID = `${'0'.repeat(39)}1`;

describe('network builders', () => {
  it('never offers a plain force push', () => {
    // --force-with-lease refuses when the remote moved; --force does not, and
    // that difference is someone else's commits.
    const args = buildPushCommand({
      remote: 'origin',
      branch: 'main',
      forceWithLease: { expect: OID },
    }).args;
    expect(args).toContain(`--force-with-lease=refs/heads/main:${OID}`);
    expect(args).not.toContain('--force');
  });

  it('leases against the oid it was given, never the bare flag', () => {
    // The bare `--force-with-lease` leases against the local remote-tracking
    // ref, which this app's own background fetch updates every five minutes —
    // renewing the lease on commits the user never saw. The lease has to name
    // the oid that was on screen when the question was asked.
    const args = buildPushCommand({
      remote: 'origin',
      branch: 'main',
      forceWithLease: { expect: OID },
    }).args;
    expect(args).not.toContain('--force-with-lease');
    expect(args.filter((arg) => arg.startsWith('--force'))).toEqual([
      `--force-with-lease=refs/heads/main:${OID}`,
    ]);
  });

  it('refuses a lease that is not a full object id', () => {
    // An abbreviation is a prefix, and a prefix can grow ambiguous; anything
    // else could carry a colon and lease against a different ref entirely.
    for (const expect_ of ['0000001', `${OID}:refs/heads/other`, 'HEAD', '']) {
      expect(() =>
        buildPushCommand({
          remote: 'origin',
          branch: 'main',
          forceWithLease: { expect: expect_ },
        }),
      ).toThrow(/object id/);
    }
  });

  it('marks a lease push destructive but a normal push not', () => {
    expect(
      buildPushCommand({ remote: 'origin', branch: 'main' }).destructive,
    ).toBeFalsy();
    expect(
      buildPushCommand({
        remote: 'origin',
        branch: 'main',
        forceWithLease: { expect: OID },
      }).destructive,
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
    expect(buildPullMergeCommand().timeoutMs).toBeGreaterThan(60_000);
  });

  it('pins the merge-pull to a merge, never a rebase, and never forces', () => {
    // pull.rebase=true in the user's config would otherwise rewrite the very
    // commits the confirmation said would be kept.
    const command = buildPullMergeCommand();
    expect(command.args).toContain('--no-rebase');
    expect(command.args).toContain('--no-edit');
    expect(command.args).not.toContain('--ff-only');
    expect(command.args).not.toContain('--force');
    expect(command.destructive).toBeFalsy();
  });

  it('overrides pull.ff=only, which is what stranded the branch to begin with', () => {
    // Without --ff, the config that made the plain pull refuse would make the
    // confirmed escape hatch refuse too, forever.
    expect(buildPullMergeCommand().args).toContain('--ff');
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

  it('reports divergence by its own kind, with a message the user can act on', async () => {
    invoke.mockResolvedValue(
      raw({
        code: 128,
        stderr: 'fatal: Not possible to fast-forward, aborting.',
      }),
    );
    await expect(pull('C:/repo')).rejects.toMatchObject({ kind: 'diverged' });
    await expect(pull('C:/repo')).rejects.toThrow(/diverged/i);
  });

  it('passes other failures through untouched', async () => {
    invoke.mockResolvedValue(raw({ code: 128, stderr: 'fatal: Authentication failed' }));
    await expect(pull('C:/repo')).rejects.toMatchObject({ kind: 'authentication' });
  });
});

describe('pullMerge', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  const OK = userConfirmed('Merge origin/main into main?');

  it('reports a clean pull', async () => {
    invoke.mockResolvedValue(raw());
    await expect(pullMerge('C:/repo', OK)).resolves.toBe('pulled');
  });

  it('reports a conflicted stop as an outcome, not a failure', async () => {
    invoke.mockResolvedValue(
      raw({
        code: 1,
        stdout:
          'CONFLICT (content): Merge conflict in src/app.ts\nAutomatic merge failed; fix conflicts and then commit the result.',
      }),
    );
    await expect(pullMerge('C:/repo', OK)).resolves.toBe('conflicted');
  });

  it('re-throws an exit-1 refusal that is not a conflict', async () => {
    invoke.mockResolvedValue(
      raw({
        code: 1,
        stderr:
          'error: Your local changes to the following files would be overwritten by merge:\n\tsrc/app.ts',
      }),
    );
    await expect(pullMerge('C:/repo', OK)).rejects.toMatchObject({
      kind: 'command-failed',
      message: expect.stringMatching(/local changes/i) as string,
    });
  });

  it('refuses a confirmation whose reason was emptied', async () => {
    invoke.mockResolvedValue(raw());
    await expect(
      pullMerge('C:/repo', { reason: '' } as unknown as ReturnType<typeof userConfirmed>),
    ).rejects.toMatchObject({ kind: 'needs-confirmation' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('refuses an object cast into the token type — nobody was asked', async () => {
    invoke.mockResolvedValue(raw());
    await expect(
      pullMerge('C:/repo', {
        reason: 'looks legitimate',
      } as unknown as ReturnType<typeof userConfirmed>),
    ).rejects.toMatchObject({ kind: 'needs-confirmation' });
    expect(invoke).not.toHaveBeenCalled();
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
      push('C:/repo', {
        remote: 'origin',
        branch: 'main',
        forceWithLease: { expect: OID },
      }),
    ).rejects.toMatchObject({ kind: 'needs-confirmation' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('runs a force push once the user has confirmed', async () => {
    invoke.mockResolvedValue(raw());
    await push(
      'C:/repo',
      { remote: 'origin', branch: 'main', forceWithLease: { expect: OID } },
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

describe('deleteTag', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('deletes the ref, once, with no force and no second attempt', async () => {
    // Unlike a branch there is no safe form to try first and no refusal to
    // escalate from: "merged" means nothing about a tag.
    invoke.mockResolvedValue(raw());
    await deleteTag('C:/repo', 'v1.0', userConfirmed('delete tag v1.0'));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      'git_run',
      expect.objectContaining({ args: ['tag', '--delete', 'v1.0'] }),
    );
  });

  it('refuses to run without a confirmation the user gave', () => {
    // Thrown before any promise exists: an object cast into the token type
    // never passed through `userConfirmed`, so nobody was ever asked.
    invoke.mockResolvedValue(raw());
    expect(() => deleteTag('C:/repo', 'v1.0', { reason: '' } as never)).toThrow(GitError);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('propagates git\u2019s refusal for a tag that is not there', async () => {
    invoke.mockResolvedValue(raw({ code: 1, stderr: "error: tag 'v9.9' not found." }));
    await expect(
      deleteTag('C:/repo', 'v9.9', userConfirmed('delete tag v9.9')),
    ).rejects.toThrow(GitError);
  });
});

describe('deleteRemoteTag', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('names the ref in full, so a branch of the same name is not what goes', async () => {
    invoke.mockResolvedValue(raw());
    await deleteRemoteTag(
      'C:/repo',
      'origin',
      'release',
      userConfirmed('delete release on origin'),
    );
    expect(invoke.mock.calls[0]?.[1].args).toEqual([
      'push',
      '--progress',
      'origin',
      '--delete',
      'refs/tags/release',
    ]);
  });

  it('refuses to run without a confirmation the user gave', async () => {
    invoke.mockResolvedValue(raw());
    await expect(
      deleteRemoteTag('C:/repo', 'origin', 'v1.0', { reason: '' } as never),
    ).rejects.toThrow(GitError);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('never reports a no-op delete as a delete', async () => {
    // Pushing a delete for a tag the remote does not have exits 0 and prints
    // `- [deleted] v9.9`; only the warning says nothing happened. Reported as
    // success it tells the user a release tag is gone from the server while it
    // is sitting there under a name they misspelled.
    invoke.mockResolvedValue(
      raw({
        stderr: 'remote: warning: deleting a non-existent ref',
        stdout: ' - [deleted]         v9.9',
      }),
    );
    await expect(
      deleteRemoteTag('C:/repo', 'origin', 'v9.9', userConfirmed('delete v9.9')),
    ).resolves.toBe('nothing-there');
  });

  it('reports a real delete as one', async () => {
    invoke.mockResolvedValue(raw({ stdout: ' - [deleted]         v1.0' }));
    await expect(
      deleteRemoteTag('C:/repo', 'origin', 'v1.0', userConfirmed('delete v1.0')),
    ).resolves.toBe('deleted');
  });
});

describe('listTags', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('parses the NUL-framed list, peeling an annotated tag to its commit', async () => {
    const commit = 'a'.repeat(40);
    const object = 'b'.repeat(40);
    invoke.mockResolvedValue(
      raw({
        stdout: [
          [
            'refs/tags/v2.0',
            object,
            'tag',
            commit,
            '2026-09-19T11:00:00+00:00',
            'ship it',
          ].join('\0'),
          ['refs/tags/v1.0', commit, 'commit', '', '2026-09-18T11:00:00+00:00', ''].join(
            '\0',
          ),
          '',
        ].join('\n'),
      }),
    );

    await expect(listTags('C:/repo')).resolves.toEqual([
      {
        name: 'v2.0',
        oid: commit,
        object,
        annotated: true,
        date: '2026-09-19T11:00:00+00:00',
        subject: 'ship it',
      },
      {
        name: 'v1.0',
        oid: commit,
        object: commit,
        annotated: false,
        date: '2026-09-18T11:00:00+00:00',
        subject: '',
      },
    ]);
  });

  it('needs no confirmation: it only reads', async () => {
    invoke.mockResolvedValue(raw({ stdout: '' }));
    await expect(listTags('C:/repo')).resolves.toEqual([]);
    expect(isDestructive(invoke.mock.calls[0]?.[1].args as string[])).toBe(false);
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

describe('pull --autostash', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('carries the flag on both pulls, so a dirty tree is not a refusal', () => {
    // "Pull did not complete, and your branch was left as it was" over one
    // edited file was the report; git's own answer is to stash around it.
    expect(buildPullCommand().args).toContain('--autostash');
    expect(buildPullMergeCommand().args).toContain('--autostash');
  });

  it('reports a clean pull as pulled', async () => {
    invoke.mockResolvedValue(
      raw({ stdout: 'Updating 1234567..89abcde\nFast-forward\n' }),
    );
    await expect(pull('C:/repo')).resolves.toBe('pulled');
  });

  it('reports an autostash git could not put back, which it exits 0 for', async () => {
    invoke.mockResolvedValue(
      raw({
        stdout: 'Updating 1234567..89abcde\nFast-forward\n',
        stderr:
          'Created autostash: 8ed340f\nApplying autostash resulted in conflicts.\nYour changes are safe in the stash.\n',
      }),
    );
    await expect(pull('C:/repo')).resolves.toBe('autostash-conflicted');
  });

  it('reports the same on the merge pull', async () => {
    invoke.mockResolvedValue(
      raw({
        stderr:
          'Your local changes are stashed, however applying them\nresulted in conflicts.  You can either resolve the conflicts\n',
      }),
    );
    await expect(
      pullMerge('C:/repo', userConfirmed('Merge origin/main into main?')),
    ).resolves.toBe('autostash-conflicted');
  });
});

describe('deleting a branch on a remote', () => {
  it('names the ref in full, so a tag of the same name is never hit', () => {
    // `git push origin --delete release` is ambiguous when both a branch and a
    // tag are called `release`, and with only the tag present it deletes the
    // tag. A delete that lands on the wrong kind of ref is the surprise this
    // app must not produce.
    expect(buildDeleteRemoteBranchCommand('origin', 'release').args).toEqual([
      'push',
      '--progress',
      'origin',
      '--delete',
      'refs/heads/release',
    ]);
  });

  it('is destructive, and says so to the runner', () => {
    // The argument gate (ADR-0016) is the second lock: it inspects the array
    // and refuses an unapproved run whatever the caller claimed.
    const command = buildDeleteRemoteBranchCommand('origin', 'topic');
    expect(command.destructive).toBe(true);
    expect(isDestructive(command.args)).toBe(true);
  });

  it('refuses a branch or remote name that would change the command', () => {
    for (const name of ['-D', '+main', 'refs/heads/x', 'a b', '']) {
      expect(() => buildDeleteRemoteBranchCommand('origin', name)).toThrow(GitError);
      expect(() => buildDeleteRemoteBranchCommand(name, 'topic')).toThrow(GitError);
    }
  });

  it('carries the network timeout, like every other push', () => {
    expect(buildDeleteRemoteBranchCommand('origin', 'topic').timeoutMs).toBe(300_000);
  });
});

describe('deleteRemoteBranch', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('refuses to run without a confirmation the user gave', () => {
    // The one gate on this side: git will happily delete a remote branch that
    // is merged nowhere, so nothing else stands between a click and a ref
    // other people fetch. The refusal is thrown before the command is built,
    // which is why this is not an awaited rejection.
    invoke.mockResolvedValue(raw());
    expect(() =>
      // @ts-expect-error the point of the test is the missing token
      deleteRemoteBranch('C:/repo', 'origin', 'topic', undefined),
    ).toThrow(GitError);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('runs once the user has confirmed', async () => {
    invoke.mockResolvedValue(raw());
    await deleteRemoteBranch(
      'C:/repo',
      'origin',
      'topic',
      userConfirmed('Delete "topic" from origin — for everyone who uses that remote?'),
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
