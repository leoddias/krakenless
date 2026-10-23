/**
 * What removing a worktree really does, against the real git binary.
 *
 * The claims an argument array cannot make: that the safe form refuses a
 * worktree with uncommitted or untracked work in the exact words
 * `removeWorktree` listens for, that one `--force` gets past that and not past
 * a lock, that `--` before the path is accepted, and that the branch the
 * worktree had checked out — and its commits — are still there afterwards.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildWorktreeRemoveCommand } from './commands/worktree';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let workspace: string;
let repo: string;
let wiki: string;

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

function remove(force: boolean): { output: string; code: number } {
  return run(repo, buildWorktreeRemoveCommand(wiki, { force }).args);
}

beforeEach(() => {
  // The real path: on some machines the temp directory is reached through a
  // link, and git prints worktree paths resolved.
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'krakenless-worktreeremove-')));
  repo = join(workspace, 'app');
  wiki = join(workspace, 'app-wiki');

  git(workspace, ['init', '--quiet', '--initial-branch', 'main', 'app']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['commit', '--quiet', '--allow-empty', '--message', 'base']);
  git(repo, ['worktree', 'add', '--quiet', '-b', 'wiki', wiki]);
  git(wiki, ['commit', '--quiet', '--allow-empty', '--message', 'only on wiki']);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('git worktree remove', () => {
  it('removes a clean worktree, and leaves its branch and commits alone', () => {
    const tip = git(repo, ['rev-parse', 'refs/heads/wiki']);

    expect(remove(false).code).toBe(0);

    expect(existsSync(wiki)).toBe(false);
    expect(git(repo, ['worktree', 'list', '--porcelain'])).not.toContain('app-wiki');
    expect(git(repo, ['rev-parse', 'refs/heads/wiki'])).toBe(tip);
  });

  it('refuses an untracked file in the words removeWorktree listens for', () => {
    writeFileSync(join(wiki, 'notes.md'), 'draft\n', 'utf8');

    const { output, code } = remove(false);

    expect(code).not.toBe(0);
    expect(output).toMatch(/contains modified or untracked files/i);
    expect(existsSync(join(wiki, 'notes.md'))).toBe(true);
  });

  it('deletes ignored files without asking, which is why the dialog says so', () => {
    // A `.env` is not uncommitted work to git: the safe form removes it with
    // the folder. Pinned so the dialog's warning cannot drift out of date.
    writeFileSync(join(wiki, '.gitignore'), '.env\n', 'utf8');
    git(wiki, ['add', '.gitignore']);
    git(wiki, ['commit', '--quiet', '--message', 'ignore .env']);
    writeFileSync(join(wiki, '.env'), 'SECRET=1\n', 'utf8');

    expect(remove(false).code).toBe(0);
    expect(existsSync(wiki)).toBe(false);
  });

  it('removes the uncommitted work too when forced', () => {
    writeFileSync(join(wiki, 'notes.md'), 'draft\n', 'utf8');

    expect(remove(true).code).toBe(0);
    expect(existsSync(wiki)).toBe(false);
  });

  it('does not get past a lock with one --force', () => {
    git(repo, ['worktree', 'lock', '--reason', 'on a laptop', wiki]);

    const { output, code } = remove(true);

    expect(code).not.toBe(0);
    expect(output).toMatch(/locked/i);
    expect(existsSync(wiki)).toBe(true);
  });
});
