/**
 * What `pull --autostash` really does, against the real git binary.
 *
 * The same three claims the rebase test makes, for the pull: uncommitted work
 * is put aside and brought back; without the flag git refuses the same pull;
 * and when bringing the work back fails, git says so **and exits 0** — the
 * case `pull` reads for, because the exit code says success while the working
 * tree is full of conflict markers. Both remotes are directories on disk.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { autostashConflicted } from './autostash';
import { buildPullCommand, buildPullMergeCommand } from './commands/remote';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let workspace: string;
let origin: string;
let clone: string;

/** Both streams and the exit code: the failed autostash is on stderr, exit 0. */
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
  git(repo, ['config', 'core.autocrlf', 'false']);
}

function commitFile(repo: string, name: string, contents: string): void {
  writeFileSync(join(repo, name), contents, 'utf8');
  git(repo, ['add', name]);
  git(repo, ['commit', '--quiet', '--message', `write ${name}`]);
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'krakenless-pull-'));
  origin = join(workspace, 'origin');
  clone = join(workspace, 'clone');

  git(workspace, ['init', '--quiet', '--initial-branch', 'main', 'origin']);
  identify(origin);
  commitFile(origin, 'shared.txt', 'base\n');
  commitFile(origin, 'other.txt', 'other\n');

  // `core.autocrlf` is set *at clone time*, not afterwards by `identify`: Git
  // for Windows ships with `core.autocrlf=true` in its system config (GitHub's
  // Windows runner keeps it), so a clone made without this checks every file
  // out with CRLF. Turning it off a moment later then makes git compare those
  // bytes against LF blobs and call every file modified — the autostash picks
  // up files the test never touched, the pull updates one of them, and the
  // restore conflicts. That failed only on the runner, where no global config
  // overrides the system one.
  git(workspace, ['-c', 'core.autocrlf=false', 'clone', '--quiet', origin, 'clone']);
  identify(clone);

  // The upstream moves on: a commit the clone does not have, to a file the
  // clone is about to edit.
  commitFile(origin, 'shared.txt', 'base\nupstream\n');
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('pull --autostash against real git', () => {
  it('refuses the same pull without the flag, which is why it is there', () => {
    // The screenshot this came from: "Pull did not complete, and your branch
    // was left as it was", over a working tree with one edited file.
    writeFileSync(join(clone, 'shared.txt'), 'base\nmine\n');

    const { code, output } = run(clone, ['pull', '--ff-only']);

    expect(code).not.toBe(0);
    expect(output).toMatch(
      /would be overwritten|Please commit your changes or stash them/i,
    );
  });

  it('pulls over uncommitted work and puts it back', () => {
    // An edit to a file the pull does not touch: the stash goes out and comes
    // back, and the edit is where it was.
    writeFileSync(join(clone, 'other.txt'), 'other, edited\n');
    // The fixture holds exactly the one edit this test made. Asserted because
    // it silently stopped being true once: a clone that checked files out with
    // CRLF made git call every file modified, the autostash carried the file
    // the pull was about to update, and the restore conflicted.
    expect(git(clone, ['status', '--short'])).toBe('M other.txt');

    const { code, output } = run(clone, buildPullCommand().args);

    expect(code).toBe(0);
    expect(autostashConflicted(output)).toBe(false);
    expect(readFileSync(join(clone, 'shared.txt'), 'utf8')).toBe('base\nupstream\n');
    expect(readFileSync(join(clone, 'other.txt'), 'utf8')).toBe('other, edited\n');
    expect(git(clone, ['stash', 'list'])).toBe('');
  });

  it('says so, and still exits 0, when the stash cannot come back', () => {
    // The same lines the upstream commit changed: the pull works, the restore
    // conflicts, and the exit code is the one thing that does not say so.
    writeFileSync(join(clone, 'shared.txt'), 'base\nmine\n');

    const { code, output } = run(clone, buildPullCommand().args);

    expect(code).toBe(0);
    expect(autostashConflicted(output)).toBe(true);
    expect(git(clone, ['stash', 'list'])).toMatch(/autostash/);
    expect(readFileSync(join(clone, 'shared.txt'), 'utf8')).toMatch(/<<<<<<</);
  });

  it('carries the flag on the merge pull too', () => {
    // The diverged case: a local commit plus an edit. Without the flag the
    // merge pull would refuse exactly as the fast-forward one does.
    commitFile(clone, 'local.txt', 'local\n');
    writeFileSync(join(clone, 'other.txt'), 'other, edited\n');

    const { code, output } = run(clone, buildPullMergeCommand().args);

    expect(code).toBe(0);
    expect(autostashConflicted(output)).toBe(false);
    expect(readFileSync(join(clone, 'other.txt'), 'utf8')).toBe('other, edited\n');
    expect(git(clone, ['log', '--format=%s', '-1'])).toMatch(/^Merge/);
  });
});
