/**
 * What `--autostash` really does, against the real git binary.
 *
 * Two of the three claims this feature rests on cannot be checked from the
 * argument array: that git puts uncommitted work aside and brings it back
 * around the replay, and that when bringing it back fails git says so **and
 * exits 0 anyway**. The second is the dangerous one — the exit code says
 * success, and the only signal that the working tree is now full of conflict
 * markers is a line of prose that `rebaseOnto` matches. If a future git changes
 * that wording, this test is what notices.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildRebaseCommand } from './commands/history';
import { autostashConflicted } from './commits';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let repo: string;

/**
 * Runs git and returns both streams together, with the exit code.
 *
 * Both streams, deliberately: git reports the failed autostash on **stderr**
 * while exiting 0, so a check that read stdout alone would find nothing and
 * conclude the rebase went cleanly — the exact mistake this file exists to
 * prevent. `rebaseOnto` reads both for the same reason.
 */
function run(args: string[]): { output: string; code: number } {
  const result = spawnSync('git', ['--no-pager', '--literal-pathspecs', ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
  return {
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    code: result.status ?? -1,
  };
}

/** Runs git, insisting it worked, and returns what it said with no padding. */
function git(args: string[]): string {
  const { output, code } = run(args);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${output}`);
  return output.trim();
}

function write(name: string, contents: string): void {
  writeFileSync(join(repo, name), contents, 'utf8');
}

function read(name: string): string {
  return readFileSync(join(repo, name), 'utf8');
}

function commitAll(message: string): void {
  git(['add', '--all']);
  git(['commit', '--quiet', '--message', message]);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'krakenless-rebase-'));
  git(['init', '--quiet', '--initial-branch=main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'core.autocrlf', 'false']);

  write('shared.txt', 'base\n');
  commitAll('base');
  git(['checkout', '--quiet', '-b', 'topic']);
  write('topic.txt', 'topic\n');
  commitAll('topic');
  git(['checkout', '--quiet', 'main']);
  write('shared.txt', 'base\nupstream\n');
  commitAll('upstream');
  git(['checkout', '--quiet', 'topic']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('rebase --autostash against real git', () => {
  it('replays over uncommitted work and puts it back', () => {
    // Without the flag this is the "cannot rebase: You have unstaged changes"
    // refusal the menu used to relay as a disabled item.
    write('untouched.txt', 'work in progress\n');
    git(['add', 'untouched.txt']);
    write('untouched.txt', 'work in progress, edited\n');

    const { code, output } = run(buildRebaseCommand('main').args);

    expect(code).toBe(0);
    expect(autostashConflicted(output)).toBe(false);
    expect(read('untouched.txt')).toBe('work in progress, edited\n');
    expect(read('shared.txt')).toBe('base\nupstream\n');
    // The replayed commit is on top of upstream, and the autostash is gone
    // because git put it back.
    expect(git(['log', '--format=%s', '-2'])).toBe('topic\nupstream');
    expect(git(['stash', 'list'])).toBe('');
  });

  it('refuses the same rebase without the flag, which is why it is there', () => {
    write('shared.txt', 'base\nmine\n');

    const { code, output } = run(['rebase', 'main']);

    expect(code).not.toBe(0);
    expect(output).toMatch(/cannot rebase|would be overwritten/i);
  });

  it('creates nothing on a clean tree', () => {
    const { code } = run(buildRebaseCommand('main').args);

    expect(code).toBe(0);
    expect(git(['stash', 'list'])).toBe('');
  });

  it('says so, and still exits 0, when the stash cannot come back', () => {
    // The exact shape `rebaseOnto` reads. An edit to the same lines the
    // upstream commit changed cannot be re-applied on top of it.
    write('shared.txt', 'base\nmine\n');

    const { code, output } = run(buildRebaseCommand('main').args);

    expect(code).toBe(0);
    // The app's own detector, not a copy of its regex: this git's wording is
    // whatever this git says, and the point is that Krakenless recognises it.
    expect(autostashConflicted(output)).toBe(true);
    // Both halves of the promise the notice makes: the work is still in a
    // stash, and the working tree is the one holding the conflict.
    expect(git(['stash', 'list'])).toMatch(/autostash/);
    expect(read('shared.txt')).toMatch(/<<<<<<</);
  });
});
