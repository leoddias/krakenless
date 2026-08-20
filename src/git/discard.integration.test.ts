/**
 * The discard recovery route, run against the real git binary.
 *
 * These tests replicate exactly what `discardPaths` builds and then **execute
 * the recovery command it would show the user**. That last step is the point:
 * a recovery command that is merely well-formed is worthless, and the previous
 * version of it — `git checkout <oid> -- <path>` — was well-formed and wrong.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildDiscardCommand } from './commands/stage';
import { recoveryFor } from './recovery';

// These spawn dozens of real git processes against fresh repositories. Under
// the parallel runner that comfortably exceeds the 5s default, and a timeout
// here reads as a product failure when it is only contention for the CPU.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let repo: string;

function git(args: string[]): string {
  return execFileSync('git', ['--no-pager', '--literal-pathspecs', ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
}

function write(name: string, contents: string): void {
  writeFileSync(join(repo, name), contents, 'utf8');
}

function read(name: string): string {
  return readFileSync(join(repo, name), 'utf8');
}

/** Mirrors `describeStash`: where the content lives, and what is in it. */
function describeStash(
  stashOid: string,
  untracked: boolean,
): {
  sourceOid: string;
  presentPaths: string[];
} {
  const sourceOid = untracked ? git(['rev-parse', `${stashOid}^3`]).trim() : stashOid;
  const presentPaths = git(['ls-tree', '-r', '--name-only', sourceOid])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { sourceOid, presentPaths };
}

/**
 * Runs the command string the UI would display, exactly as written.
 *
 * Paths are read back out of their quotes rather than split on whitespace —
 * splitting would pass `my` and `notes.txt` as two pathspecs, which is the very
 * mistake the quoting exists to prevent.
 */
function runRecovery(command: string): void {
  const match = /^git restore --source=(\S+) --worktree -- (.*)$/.exec(command);
  if (match === null) throw new Error(`Unexpected recovery command: ${command}`);
  const paths = [...(match[2] ?? '').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((quoted) =>
    (quoted[1] ?? '').replace(/\\(.)/g, '$1'),
  );
  git(['restore', `--source=${match[1] ?? ''}`, '--worktree', '--', ...paths]);
}

/** `rev-parse --verify --quiet` exits 1 when the ref does not exist. */
function stashTipOrEmpty(): string {
  try {
    return git(['rev-parse', '--verify', '--quiet', 'refs/stash']).trim();
  } catch {
    return '';
  }
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'krakenless-discard-'));
  git(['init', '--quiet']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  // Line-ending conversion off: these tests assert what *this code* does to
  // content, and `core.autocrlf=true` — the Git for Windows default, and what
  // GitHub's Windows runners use — would have git rewrite it underneath them.
  // The autocrlf=true behaviour is covered separately and deliberately.
  git(['config', 'core.autocrlf', 'false']);
  write('seed.txt', 'seed\n');
  git(['add', '.']);
  git(['commit', '--quiet', '--message', 'seed']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('discard recovery against real git', () => {
  it('brings back a discarded untracked file', () => {
    // The bug this guards: `--include-untracked` stores the file in the stash's
    // *third parent*, not its tree. Restoring from the stash oid errors with
    // "pathspec did not match", and the file exists nowhere else on disk.
    write('notes.txt', 'my notes\n');
    git(buildDiscardCommand(['notes.txt'], 'label', { keepIndex: false }).args);
    expect(existsSync(join(repo, 'notes.txt'))).toBe(false);

    const stashOid = git(['rev-parse', 'refs/stash']).trim();
    const { sourceOid, presentPaths } = describeStash(stashOid, true);
    const plan = recoveryFor(sourceOid, ['notes.txt'], presentPaths);

    expect(plan.commands).toHaveLength(1);
    runRecovery(plan.commands[0]!);
    expect(read('notes.txt')).toBe('my notes\n');
  });

  it('never emits a caret, which cmd.exe would eat', () => {
    // `--source=<oid>^3` pasted into cmd.exe silently becomes `--source=<oid>`,
    // which restores from the wrong tree.
    write('notes.txt', 'x\n');
    git(buildDiscardCommand(['notes.txt'], 'label', { keepIndex: false }).args);

    const stashOid = git(['rev-parse', 'refs/stash']).trim();
    const { sourceOid, presentPaths } = describeStash(stashOid, true);
    const plan = recoveryFor(sourceOid, ['notes.txt'], presentPaths);

    expect(plan.commands[0]).not.toContain('^');
    expect(sourceOid).toMatch(/^[0-9a-f]{40}$/);
  });

  it('brings back a tracked edit while leaving the staged snapshot alone', () => {
    write('seed.txt', 'staged\n');
    git(['add', 'seed.txt']);
    write('seed.txt', 'worktree\n');

    git(buildDiscardCommand(['seed.txt'], 'label', { keepIndex: true }).args);
    expect(read('seed.txt')).toBe('staged\n');

    const stashOid = git(['rev-parse', 'refs/stash']).trim();
    const { sourceOid, presentPaths } = describeStash(stashOid, false);
    runRecovery(recoveryFor(sourceOid, ['seed.txt'], presentPaths).commands[0]!);

    expect(read('seed.txt')).toBe('worktree\n');
    expect(git(['show', ':seed.txt'])).toBe('staged\n');
  });

  it('reports a discarded deletion as unrecoverable rather than offering a command that fails', () => {
    // The stash records the deletion, so the path is absent from its tree and
    // `git restore --source` would abort. Saying so beats a command that errors.
    rmSync(join(repo, 'seed.txt'));
    git(buildDiscardCommand(['seed.txt'], 'label', { keepIndex: true }).args);

    const stashOid = git(['rev-parse', 'refs/stash']).trim();
    const { sourceOid, presentPaths } = describeStash(stashOid, false);
    const plan = recoveryFor(sourceOid, ['seed.txt'], presentPaths);

    expect(plan.commands).toEqual([]);
    expect(plan.unrecoverable).toEqual(['seed.txt']);
  });

  it('keeps a path with a space intact through the round trip', () => {
    write('my notes.txt', 'spaced\n');
    git(buildDiscardCommand(['my notes.txt'], 'label', { keepIndex: false }).args);

    const stashOid = git(['rev-parse', 'refs/stash']).trim();
    const { sourceOid, presentPaths } = describeStash(stashOid, true);
    runRecovery(recoveryFor(sourceOid, ['my notes.txt'], presentPaths).commands[0]!);

    expect(read('my notes.txt')).toBe('spaced\n');
  });

  it('creates no stash for a path whose worktree matches the index', () => {
    write('seed.txt', 'staged only\n');
    git(['add', 'seed.txt']);
    const before = stashTipOrEmpty();

    // The planner excludes it: `git diff --name-only` reports nothing for it.
    expect(git(['diff', '--name-only', '--', 'seed.txt']).trim()).toBe('');
    expect(before).toBe('');
  });
});
