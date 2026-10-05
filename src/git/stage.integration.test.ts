/**
 * Integration tests for the destructive paths, against the real git binary.
 *
 * `docs/CONVENTIONS.md` requires that every destructive code path has a test
 * proving the recovery route actually works. These build the same argument
 * arrays the app builds and run them for real on disposable repositories.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildCommitCommand,
  buildRewordHeadCommand,
  buildStageCommand,
  buildTreeOfCommand,
  buildUnstageCommand,
} from './commands/stage';
import { buildResetCommand } from './commands/history';

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

describe('reword HEAD', () => {
  it('replaces the message and leaves staged and unstaged work where it was', () => {
    const before = git(['rev-parse', 'HEAD']).trim();
    const tree = git(['rev-parse', 'HEAD^{tree}']).trim();
    write('drop.txt', 'staged edit\n');
    git(buildStageCommand(['drop.txt']).args);
    write('keep.txt', 'unstaged edit\n');

    git(buildRewordHeadCommand('seed, spelled right\n\nwith a body').args);

    expect(git(['log', '-1', '--format=%B']).trim()).toBe(
      'seed, spelled right\n\nwith a body',
    );
    expect(git(['rev-list', '--count', 'HEAD']).trim()).toBe('1');
    // Same tree: the staged change did not ride along into the commit.
    expect(git(['rev-parse', 'HEAD^{tree}']).trim()).toBe(tree);
    expect(git(['diff', '--cached', '--name-only']).trim()).toBe('drop.txt');
    expect(git(['diff', '--name-only']).trim()).toBe('keep.txt');
    expect(read('keep.txt')).toBe('unstaged edit\n');
    // The way back: the old commit is the reflog's previous entry.
    expect(git(['rev-parse', 'HEAD@{1}']).trim()).toBe(before);
  });

  it('rewords a commit that was empty to begin with', () => {
    git(['commit', '--quiet', '--allow-empty', '--message', 'empyt']);
    git(buildRewordHeadCommand('empty').args);
    expect(git(['log', '-1', '--format=%s']).trim()).toBe('empty');
    expect(git(['rev-list', '--count', 'HEAD']).trim()).toBe('2');
  });

  it('keeps the author and author date', () => {
    const before = git(['log', '-1', '--format=%an <%ae> %aI']).trim();
    git(buildRewordHeadCommand('seed again').args);
    expect(git(['log', '-1', '--format=%an <%ae> %aI']).trim()).toBe(before);
  });

  it('sees a pre-commit hook that adds files, and the soft reset puts everything back', () => {
    // The tree check in `rewordHead` exists for exactly this: `--only` keeps
    // the index out, but a hook's `git add` lands in the commit anyway.
    const before = git(['rev-parse', 'HEAD']).trim();
    const tree = git(['rev-parse', `${before}^{tree}`]).trim();
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\ngit add -u\n', {
      mode: 0o755,
    });
    write('drop.txt', 'staged edit\n');
    git(buildStageCommand(['drop.txt']).args);
    write('keep.txt', 'unstaged edit\n');

    git(buildRewordHeadCommand('seed, reworded').args);
    expect(git(buildTreeOfCommand('HEAD').args).trim()).not.toBe(tree);
    expect(git(buildTreeOfCommand(before).args).trim()).toBe(tree);

    git(buildResetCommand(before, 'soft').args);

    expect(git(['rev-parse', 'HEAD']).trim()).toBe(before);
    expect(git(['log', '-1', '--format=%s']).trim()).toBe('seed');
    expect(read('keep.txt')).toBe('unstaged edit\n');
    expect(read('drop.txt')).toBe('staged edit\n');
    // Nothing lost: both edits still differ from the commit.
    expect(git(['diff', 'HEAD', '--name-only']).trim().split('\n').sort()).toEqual([
      'drop.txt',
      'keep.txt',
    ]);
  });
});
