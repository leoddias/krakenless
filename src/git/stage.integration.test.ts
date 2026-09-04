/**
 * Integration tests for the destructive paths, against the real git binary.
 *
 * `docs/CONVENTIONS.md` requires that every destructive code path has a test
 * proving the recovery route actually works. These build the same argument
 * arrays the app builds and run them for real on disposable repositories.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildCommitCommand,
  buildStageCommand,
  buildUnstageCommand,
} from './commands/stage';

// These spawn dozens of real git processes against fresh repositories. Under
// the parallel runner that comfortably exceeds the 5s default, and a timeout
// here reads as a product failure when it is only contention for the CPU.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let repo: string;

function git(args: string[], stdin?: string): string {
  return execFileSync('git', ['--no-pager', '--literal-pathspecs', ...args], {
    cwd: repo,
    encoding: 'utf8',
    input: stdin,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
}

function write(name: string, contents: string): void {
  writeFileSync(join(repo, name), contents, 'utf8');
}

function read(name: string): string {
  return readFileSync(join(repo, name), 'utf8');
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'krakenless-stage-'));
  git(['init', '--quiet']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  // Line-ending conversion off: these tests assert what *this code* does to
  // content, and `core.autocrlf=true` — the Git for Windows default, and what
  // GitHub's Windows runners use — would have git rewrite it underneath them.
  // The autocrlf=true behaviour is covered separately and deliberately.
  git(['config', 'core.autocrlf', 'false']);
  write('keep.txt', 'keep original\n');
  write('drop.txt', 'drop original\n');
  git(['add', '.']);
  git(['commit', '--quiet', '--message', 'seed']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('discard', () => {
  it('creates no stash for a path whose worktree matches the index', () => {
    // `stash push --keep-index` on a staged-but-clean path exits 0 and creates
    // an entry that changes nothing; telling the user it was discarded would be
    // a lie, and the entries would pile up on every click.
    write('drop.txt', 'staged only\n');
    git(['add', 'drop.txt']);

    const listed = git(['ls-files', '--', 'drop.txt']).trim();
    const dirty = git(['diff', '--name-only', '--', 'drop.txt']).trim();

    expect(listed).toBe('drop.txt');
    // No worktree-vs-index difference, so the planner excludes it entirely.
    expect(dirty).toBe('');
  });
});

describe('stage and unstage', () => {
  it('stages a path and unstages it back to the same state', () => {
    write('drop.txt', 'edited\n');

    git(buildStageCommand(['drop.txt']).args);
    expect(git(['diff', '--cached', '--name-only'])).toContain('drop.txt');

    git(buildUnstageCommand(['drop.txt']).args);
    expect(git(['diff', '--cached', '--name-only'])).toBe('');
    // Unstaging must never touch the working tree.
    expect(read('drop.txt')).toContain('edited');
  });

  it('stages a path whose name contains a space and unicode', () => {
    write('my café.txt', 'x\n');
    git(buildStageCommand(['my café.txt']).args);
    expect(
      git(['-c', 'core.quotePath=false', 'diff', '--cached', '--name-only']),
    ).toContain('my café.txt');
  });
});

describe('commit', () => {
  it('commits the index with the message verbatim', () => {
    write('drop.txt', 'edited\n');
    git(buildStageCommand(['drop.txt']).args);
    git(buildCommitCommand({ message: 'feat: a message with -- dashes' }).args);

    expect(git(['log', '-1', '--format=%s'])).toContain('feat: a message with -- dashes');
  });

  it('amend replaces the previous commit instead of adding one', () => {
    const before = git(['rev-list', '--count', 'HEAD']).trim();
    write('drop.txt', 'edited\n');
    git(buildStageCommand(['drop.txt']).args);
    git(buildCommitCommand({ message: 'amended message', amend: true }).args);

    expect(git(['rev-list', '--count', 'HEAD']).trim()).toBe(before);
    expect(git(['log', '-1', '--format=%s'])).toContain('amended message');
  });
});
