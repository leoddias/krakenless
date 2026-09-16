/**
 * Creating a stash, against the real git binary.
 *
 * The claim under test is the one the safety bar cares about: the work leaves
 * the working tree but is **recoverable** — a `pop` puts every file back where
 * it was, byte for byte, including the untracked ones when they were asked for.
 * Asserting the argument list proves none of that; only git can say whether
 * `--include-untracked` and the `--` terminator behave the way the builder's
 * comments claim.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildStashPushCommand } from './commands/stage';
import type { GitCommand } from './types';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let repo: string;

function run(command: GitCommand): string {
  return execFileSync('git', ['--no-pager', '--literal-pathspecs', ...command.args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    ...(command.stdin === undefined ? {} : { input: command.stdin }),
  });
}

function git(args: string[]): string {
  return run({ args });
}

function write(path: string, text: string): void {
  writeFileSync(join(repo, path), text);
}

function read(path: string): string {
  return readFileSync(join(repo, path), 'utf8');
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'krakenless-stash-'));
  git(['init', '--quiet']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'core.autocrlf', 'false']);
  write('tracked.txt', 'original\n');
  write('.gitignore', 'ignored.txt\n');
  git(['add', 'tracked.txt', '.gitignore']);
  git(['commit', '--quiet', '--message', 'seed']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('stashing the working tree, against real git', () => {
  it('takes a tracked edit off the tree and gives it back on pop', () => {
    write('tracked.txt', 'edited\n');

    run(buildStashPushCommand());
    expect(read('tracked.txt')).toBe('original\n');
    expect(git(['stash', 'list']).trim()).not.toBe('');

    git(['stash', 'pop']);
    expect(read('tracked.txt')).toBe('edited\n');
  });

  it('leaves untracked files on disk, which is what plain git stash does', () => {
    write('new.txt', 'brand new\n');
    write('tracked.txt', 'edited\n');

    run(buildStashPushCommand());

    expect(read('new.txt')).toBe('brand new\n');
    expect(read('tracked.txt')).toBe('original\n');
  });

  it('leaves an ignored file alone', () => {
    write('ignored.txt', 'secret\n');
    write('tracked.txt', 'edited\n');

    run(buildStashPushCommand());

    expect(read('ignored.txt')).toBe('secret\n');
  });

  it('records the message rather than reading it as a flag', () => {
    write('tracked.txt', 'edited\n');

    run(buildStashPushCommand({ message: '--force everything' }));

    expect(git(['stash', 'list'])).toContain('--force everything');
    // And it really is one entry, not a command that did something else.
    expect(git(['stash', 'list']).trim().split('\n')).toHaveLength(1);
  });

  it('creates nothing on a clean tree, and does not fail', () => {
    // The row that offers this is hidden when there is nothing to stash, but a
    // status read and a stash are two moments; git's own answer is the
    // backstop.
    run(buildStashPushCommand());

    expect(git(['stash', 'list']).trim()).toBe('');
  });

  it('brings a staged change back unchanged', () => {
    // `git stash pop` without `--index` restores the content but not the
    // index. Whatever git does about staging, the bytes must come back.
    write('tracked.txt', 'staged edit\n');
    git(['add', 'tracked.txt']);

    run(buildStashPushCommand());
    expect(read('tracked.txt')).toBe('original\n');

    git(['stash', 'pop']);
    expect(read('tracked.txt')).toBe('staged edit\n');
  });

  it('pins why --include-untracked is not offered', () => {
    // This is the whole reason the builder has no untracked option. Under the
    // runner's global --literal-pathspecs (ADR-0015) git writes the untracked
    // file into the stash entry *and leaves it on disk*, and the pop that
    // should undo the stash then refuses. If a future git fixes this, or the
    // runner stops sending the flag, this test fails and the option can be
    // reconsidered — which is exactly when it should be.
    write('tracked.txt', 'edited\n');
    write('new.txt', 'brand new\n');

    run({ args: ['stash', 'push', '--include-untracked'] });

    expect(existsSync(join(repo, 'new.txt'))).toBe(true);
    const popped = spawnSync(
      'git',
      ['--no-pager', '--literal-pathspecs', 'stash', 'pop'],
      {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
      },
    );
    expect(popped.status).not.toBe(0);
    expect(`${popped.stderr}${popped.stdout}`).toContain(
      'could not restore untracked files from stash',
    );
  });
});

describe('why a stash must never run mid-operation', () => {
  /**
   * The failure this pins is the reason `stashRefusalReason` and the guard in
   * `stashAll` exist. It is deliberately a test of *git's* behaviour, not of
   * the guard: the guard is only worth having while this stays true, and if a
   * future git stops losing the commit, this test says so.
   */
  it('a rebase reports success while the replayed commit leaves the branch', () => {
    git(['checkout', '--quiet', '-b', 'topic']);
    write('tracked.txt', 'topic work\n');
    git(['commit', '--quiet', '--all', '--message', 'topic commit']);
    const topicCommit = git(['rev-parse', 'HEAD']).trim();

    git(['checkout', '--quiet', 'master']);
    write('tracked.txt', 'master work\n');
    git(['commit', '--quiet', '--all', '--message', 'master commit']);

    git(['checkout', '--quiet', 'topic']);
    // Conflicts, as the app's conflict screen would find it.
    spawnSync('git', ['--no-pager', '--literal-pathspecs', 'rebase', 'master'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    });
    // The resolver stages the resolution, which is what leaves the tree no
    // longer unmerged and lets the stash through.
    write('tracked.txt', 'resolved\n');
    git(['add', 'tracked.txt']);

    run(buildStashPushCommand());
    const continued = spawnSync(
      'git',
      ['--no-pager', '--literal-pathspecs', 'rebase', '--continue'],
      {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C', GIT_EDITOR: 'true' },
      },
    );

    // git says it worked...
    expect(`${continued.stdout}${continued.stderr}`).toContain('Successfully rebased');
    // ...and the commit being replayed is not on the branch any more.
    const onBranch = git(['log', '--format=%H', 'master..topic']).trim();
    expect(onBranch).toBe('');
    expect(git(['log', '--format=%s', '-1', 'topic']).trim()).toBe('master commit');
    // It is not referenced by the branch at all — only the stash and the reflog
    // still know about it, which is not somewhere a user will look.
    expect(git(['rev-parse', 'HEAD']).trim()).not.toBe(topicCommit);
  });
});
