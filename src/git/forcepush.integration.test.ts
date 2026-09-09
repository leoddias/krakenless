/**
 * What the lease of a force push really does, against the real git binary.
 *
 * Three claims, and none of them can be made from the argument array. That the
 * explicit `--force-with-lease=refs/heads/<branch>:<oid>` form is one git
 * accepts at all — a lease git does not understand is a lease that does not
 * protect anything, and this app builds no other kind. That a remote which
 * moved since the oid was read makes git *refuse*, which is the entire reason
 * this feature is allowed to exist. And that the refusal says "stale info", the
 * words `classifyFailure` reads to tell the user their teammate's push is still
 * there. Every remote here is a directory on disk; nothing touches a network.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildPushCommand } from './commands/remote';
import { classifyFailure } from './errors';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let workspace: string;
let origin: string;
let mine: string;
let theirs: string;

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

/** Where *this* clone last saw the remote branch — the oid the UI shows. */
function trackedHead(repo: string): string {
  return git(repo, ['rev-parse', 'refs/remotes/origin/main']);
}

function push(repo: string, expect_?: string): { output: string; code: number } {
  const command = buildPushCommand({
    remote: 'origin',
    branch: 'main',
    ...(expect_ === undefined ? {} : { forceWithLease: { expect: expect_ } }),
  });
  return run(repo, command.args);
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'krakenless-forcepush-'));
  origin = join(workspace, 'origin');
  mine = join(workspace, 'mine');
  theirs = join(workspace, 'theirs');

  // Bare, because a push to the branch a working tree has checked out is
  // refused for reasons that have nothing to do with the lease.
  git(workspace, ['init', '--quiet', '--bare', '--initial-branch', 'main', 'origin']);

  git(workspace, ['clone', '--quiet', origin, 'mine']);
  identify(mine);
  commitFile(mine, 'base.txt', 'base\n');
  git(mine, ['push', '--quiet', '--set-upstream', 'origin', 'main']);

  git(workspace, ['clone', '--quiet', origin, 'theirs']);
  identify(theirs);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('force push with a lease, against real git', () => {
  it('replaces the remote branch when the lease still holds', () => {
    // The ordinary case: nobody else pushed, so the oid this clone last saw is
    // where the remote still is. `--amend` is the everyday route here — the
    // commit is rewritten, and the branch stops being a fast-forward.
    const base = trackedHead(mine);
    writeFileSync(join(mine, 'base.txt'), 'base, rewritten\n');
    git(mine, ['commit', '--quiet', '--all', '--amend', '--message', 'rewritten']);
    const rewritten = git(mine, ['rev-parse', 'HEAD']);

    // Without the lease git refuses it, which is what makes the button exist.
    expect(push(mine).code).not.toBe(0);

    const { code, output } = push(mine, base);

    expect(code).toBe(0);
    expect(output).toMatch(/forced update|\+ /);
    expect(remoteHead()).toBe(rewritten);
  });

  it('refuses when the remote moved since the oid was read', () => {
    // The case the whole feature rests on: a teammate pushed while this user
    // was rewriting, and this clone has not fetched since. The lease names the
    // commit the app had on screen, and that is no longer where the remote is.
    const stale = trackedHead(mine);
    const theirCommit = commitFile(theirs, 'theirs.txt', 'theirs\n');
    git(theirs, ['push', '--quiet', 'origin', 'main']);
    expect(remoteHead()).toBe(theirCommit);

    writeFileSync(join(mine, 'base.txt'), 'base, rewritten\n');
    git(mine, ['commit', '--quiet', '--all', '--amend', '--message', 'rewritten']);

    const { code, output } = push(mine, stale);

    expect(code).not.toBe(0);
    // Their commit is untouched: the refusal is the point, not a consolation.
    expect(remoteHead()).toBe(theirCommit);
    // And the app can say so in its own words rather than relaying
    // "failed to push some refs", which reads as a network problem.
    const error = classifyFailure(['push'], {
      stdout: '',
      stderr: output,
      code,
      timedOut: false,
      stdoutLossy: false,
    });
    expect(error.kind).toBe('stale-info');
    expect(error.message).toMatch(/moved since/);
  });

  it('goes through once the user has fetched and leased against what arrived', () => {
    // The recovery from the refusal above, and the reason it is safe: the user
    // has now seen the commit they are about to drop.
    const theirCommit = commitFile(theirs, 'theirs.txt', 'theirs\n');
    git(theirs, ['push', '--quiet', 'origin', 'main']);

    writeFileSync(join(mine, 'base.txt'), 'base, rewritten\n');
    git(mine, ['commit', '--quiet', '--all', '--amend', '--message', 'rewritten']);
    const rewritten = git(mine, ['rev-parse', 'HEAD']);

    git(mine, ['fetch', '--quiet', 'origin']);
    expect(trackedHead(mine)).toBe(theirCommit);

    expect(push(mine, trackedHead(mine)).code).toBe(0);

    expect(remoteHead()).toBe(rewritten);
    // Their commit is off the branch, which is exactly what the confirmation
    // said would happen — and still in the repository until git collects it.
    expect(
      run(origin, ['merge-base', '--is-ancestor', theirCommit, 'refs/heads/main']).code,
    ).not.toBe(0);

    // And the way back the notice offers actually works. It can only work
    // because the lease matched: matching means this clone had fetched that
    // commit, so the object is here even though no ref points at it any more.
    git(mine, ['branch', `recovered-origin-main`, theirCommit]);
    expect(git(mine, ['rev-parse', 'recovered-origin-main'])).toBe(theirCommit);
    expect(git(mine, ['cat-file', '-t', theirCommit])).toBe('commit');
  });

  it('leaves every other branch alone', () => {
    // The lease names one ref and the refspec pushes one ref. A `--force` with
    // a `--mirror`-shaped argument list is how people delete branches by
    // accident; this command cannot express that.
    git(mine, ['branch', 'keep-me']);
    git(mine, ['push', '--quiet', 'origin', 'keep-me']);
    const kept = git(mine, ['rev-parse', 'refs/heads/keep-me']);

    const base = trackedHead(mine);
    writeFileSync(join(mine, 'base.txt'), 'base, rewritten\n');
    git(mine, ['commit', '--quiet', '--all', '--amend', '--message', 'rewritten']);

    expect(push(mine, base).code).toBe(0);

    expect(git(origin, ['rev-parse', 'refs/heads/keep-me'])).toBe(kept);
  });
});
