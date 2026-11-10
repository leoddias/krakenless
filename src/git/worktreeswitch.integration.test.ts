/**
 * Taking a branch from another worktree, against the real git binary
 * (ADR-0068).
 *
 * The claims an argument array cannot make: that git really does refuse the
 * plain switch while another worktree holds the branch, that `switch --detach`
 * with no start point moves nothing in a *dirty* holder, that the switch here
 * then succeeds, and that `switch <branch>` in the holder puts it back without
 * touching its files either.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSwitchCommand } from './commands/branch';
import {
  buildBisectLogCommand,
  buildDetachHeadCommand,
  buildHeadRefCommand,
} from './commands/worktree';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let workspace: string;
let repo: string;
let fix: string;

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

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'krakenless-worktreeswitch-')));
  repo = join(workspace, 'app');
  fix = join(workspace, 'main-fix');

  git(workspace, ['init', '--quiet', '--initial-branch', 'main', 'app']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'a.txt'), 'one\n', 'utf8');
  git(repo, ['add', 'a.txt']);
  git(repo, ['commit', '--quiet', '--message', 'base']);
  git(repo, ['switch', '--quiet', '--create', 'feature']);
  // The shape from the bug report: `main` lives in a linked worktree, and the
  // main checkout is on a feature branch that wants to go back to it.
  git(repo, ['worktree', 'add', '--quiet', fix, 'main']);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('taking a branch from another worktree', () => {
  it('is refused by a plain switch, which is the whole problem', () => {
    const { output, code } = run(repo, buildSwitchCommand('main').args);
    expect(code).not.toBe(0);
    expect(output).toMatch(/already (checked out|used by worktree)/);
  });

  it('detaches a dirty holder without moving a byte, then the switch here works', () => {
    writeFileSync(join(fix, 'a.txt'), 'edited, not committed\n', 'utf8');
    writeFileSync(join(fix, 'new.txt'), 'untracked\n', 'utf8');
    const tip = git(repo, ['rev-parse', 'refs/heads/main']);

    expect(run(fix, buildDetachHeadCommand().args).code).toBe(0);

    expect(readFileSync(join(fix, 'a.txt'), 'utf8')).toBe('edited, not committed\n');
    expect(readFileSync(join(fix, 'new.txt'), 'utf8')).toBe('untracked\n');
    expect(git(fix, ['rev-parse', 'HEAD'])).toBe(tip);
    expect(git(fix, ['status', '--porcelain'])).toContain('a.txt');
    // The branch did not move.
    expect(git(repo, ['rev-parse', 'refs/heads/main'])).toBe(tip);

    expect(run(repo, buildSwitchCommand('main').args).code).toBe(0);
    expect(git(repo, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
  });

  it('reads the holder as on the branch, by its full ref, and detached as exit 1', () => {
    const on = run(fix, buildHeadRefCommand().args);
    expect(on.code).toBe(0);
    expect(on.output.trim()).toBe('refs/heads/main');

    expect(run(fix, buildDetachHeadCommand().args).code).toBe(0);
    expect(run(fix, buildHeadRefCommand().args).code).toBe(1);
  });

  it('tells a bisect under way from none by the exit code alone', () => {
    // `--no-checkout` is the one bisect that keeps the branch checked out —
    // the one a detach would strand.
    expect(run(fix, buildBisectLogCommand().args).code).toBe(1);
    git(fix, ['bisect', 'start', '--no-checkout']);
    expect(run(fix, buildBisectLogCommand().args).code).toBe(0);
    expect(git(fix, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
  });

  it('puts the holder back on the branch, files untouched, when nothing else took it', () => {
    writeFileSync(join(fix, 'a.txt'), 'still mine\n', 'utf8');
    expect(run(fix, buildDetachHeadCommand().args).code).toBe(0);

    expect(run(fix, buildSwitchCommand('main').args).code).toBe(0);

    expect(git(fix, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
    expect(readFileSync(join(fix, 'a.txt'), 'utf8')).toBe('still mine\n');
  });
});
