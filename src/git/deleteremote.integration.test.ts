/**
 * What deleting a branch on a remote really does, against the real git binary.
 *
 * The claims that cannot be made from an argument array: that the delete takes
 * the branch and only the branch, that a tag of the same name is untouched
 * (the reason the ref is fully qualified), that the commits stay on the server
 * so the recovery push the notice offers actually recreates the branch, and
 * that a server refusing comes back as a failure rather than as silence. The
 * remote is a directory on disk; nothing touches a network.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildDeleteRemoteBranchCommand } from './commands/remote';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let workspace: string;
let origin: string;
let mine: string;

function run(cwd: string, args: string[]): { output: string; code: number } {
  const result = spawnSync('git', ['--no-pager', '--literal-pathspecs', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
  return {
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    code: result.status ?? -1,
  };
}

function git(cwd: string, args: string[]): string {
  const { output, code } = run(cwd, args);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${output}`);
  return output.trim();
}

function identify(repo: string): void {
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  // Set at clone time everywhere else in this suite; harmless here, where no
  // test compares file bytes, and kept for the same reason.
  git(repo, ['config', 'core.autocrlf', 'false']);
}

function commitFile(repo: string, name: string, contents: string): string {
  writeFileSync(join(repo, name), contents, 'utf8');
  git(repo, ['add', name]);
  git(repo, ['commit', '--quiet', '--message', `write ${name}`]);
  return git(repo, ['rev-parse', 'HEAD']);
}

/** Where the remote branch actually is, which is what the lease is about. */
function remoteHead(): string {
  return git(origin, ['rev-parse', 'refs/heads/main']);
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'krakenless-deleteremote-'));
  origin = join(workspace, 'origin');
  mine = join(workspace, 'mine');

  // Bare, because a push to the branch a working tree has checked out is
  // refused for reasons that have nothing to do with the lease.
  git(workspace, ['init', '--quiet', '--bare', '--initial-branch', 'main', 'origin']);

  git(workspace, ['clone', '--quiet', origin, 'mine']);
  identify(mine);
  commitFile(mine, 'base.txt', 'base\n');
  git(mine, ['push', '--quiet', '--set-upstream', 'origin', 'main']);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('deleting a branch on a remote, against real git', () => {
  /** A branch on the remote, and the oid the panel would have shown for it. */
  function publish(name: string, file: string): string {
    git(mine, ['switch', '--quiet', '--create', name]);
    const oid = commitFile(mine, file, `${file}\n`);
    git(mine, ['push', '--quiet', 'origin', name]);
    git(mine, ['switch', '--quiet', 'main']);
    return oid;
  }

  it('removes the branch and nothing else', () => {
    publish('feat/one', 'one.txt');
    publish('feat/two', 'two.txt');

    const { code } = run(mine, buildDeleteRemoteBranchCommand('origin', 'feat/one').args);

    expect(code).toBe(0);
    const refs = git(origin, ['for-each-ref', '--format=%(refname)']);
    expect(refs).not.toContain('refs/heads/feat/one');
    expect(refs).toContain('refs/heads/feat/two');
    expect(refs).toContain('refs/heads/main');
  });

  it('never hits a tag that shares the branch name', () => {
    // The reason the ref is fully qualified. `git push origin --delete release`
    // with only a tag of that name deletes the tag, which is a ref nobody
    // asked about and the one kind that is often the only name on a commit.
    publish('release', 'release.txt');
    git(mine, ['tag', 'release-tag']);
    git(mine, ['push', '--quiet', 'origin', 'refs/tags/release-tag']);

    expect(run(mine, buildDeleteRemoteBranchCommand('origin', 'release').args).code).toBe(
      0,
    );

    const refs = git(origin, ['for-each-ref', '--format=%(refname)']);
    expect(refs).not.toContain('refs/heads/release');
    expect(refs).toContain('refs/tags/release-tag');
  });

  it('leaves the commits on the server, so the recovery push works', () => {
    // What the notice promises: deleting a branch removes the *name*. The
    // commits are still in this clone — the row was drawn from a
    // remote-tracking ref pointing at them — so pushing the oid back recreates
    // the branch exactly where it was.
    const oid = publish('feat/one', 'one.txt');

    run(mine, buildDeleteRemoteBranchCommand('origin', 'feat/one').args);
    expect(git(origin, ['for-each-ref', '--format=%(refname)'])).not.toContain(
      'refs/heads/feat/one',
    );

    git(mine, ['push', '--quiet', 'origin', `${oid}:refs/heads/feat/one`]);

    expect(git(origin, ['rev-parse', 'refs/heads/feat/one'])).toBe(oid);
  });

  it('reports the server refusing, rather than claiming a delete', () => {
    // Deleting the branch HEAD points at is the refusal every server has some
    // version of. The app must relay it, not swallow it.
    const { code, output } = run(
      mine,
      buildDeleteRemoteBranchCommand('origin', 'main').args,
    );

    expect(code).not.toBe(0);
    expect(output).toMatch(/refusing to delete|remote rejected|\[remote rejected\]/i);
    expect(git(origin, ['rev-parse', 'refs/heads/main'])).toBe(remoteHead());
  });
});
