/**
 * Integration tests for the destructive paths, against the real git binary.
 *
 * `docs/CONVENTIONS.md` requires that every destructive code path has a test
 * proving the recovery route actually works. These build the same argument
 * arrays the app builds and run them for real on disposable repositories.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCommitCommand,
  buildDiscardCommand,
  buildStageCommand,
  buildStashApplyCommand,
  buildUnstageCommand,
} from './commands/stage';

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
  write('keep.txt', 'keep original\n');
  write('drop.txt', 'drop original\n');
  git(['add', '.']);
  git(['commit', '--quiet', '--message', 'seed']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('discard', () => {
  it('is recoverable: the discarded change comes back with stash pop', () => {
    // This is the test that makes "discard" safe to offer at all.
    write('drop.txt', 'drop edited\n');

    git(
      buildDiscardCommand(['drop.txt'], 'krakenless: discarded test', { keepIndex: true })
        .args,
    );
    expect(read('drop.txt')).toContain('drop original');

    git(buildStashApplyCommand('stash@{0}', { pop: true }).args);
    expect(read('drop.txt')).toContain('drop edited');
  });

  it('keeps the staged snapshot of a file that is both staged and dirty', () => {
    // The failure this guards: without --keep-index the stash reverts the index
    // to HEAD as well, and `git stash pop` never restores that staged version —
    // the user's staged work would be gone with no route back.
    write('drop.txt', 'staged version\n');
    git(['add', 'drop.txt']);
    write('drop.txt', 'worktree version\n');

    git(buildDiscardCommand(['drop.txt'], 'label', { keepIndex: true }).args);

    expect(git(['show', ':drop.txt'])).toBe('staged version\n');
    expect(read('drop.txt')).toBe('staged version\n');
  });

  it('can restore the discarded edit from the stash commit by oid', () => {
    // The undo command the UI shows is `git checkout <oid> -- <paths>`; a
    // `stash pop` would conflict against the restored staged content.
    write('drop.txt', 'staged version\n');
    git(['add', 'drop.txt']);
    write('drop.txt', 'worktree version\n');
    git(buildDiscardCommand(['drop.txt'], 'label', { keepIndex: true }).args);

    const oid = git(['rev-parse', 'refs/stash']).trim();
    git(['checkout', oid, '--', 'drop.txt']);

    expect(read('drop.txt')).toBe('worktree version\n');
  });

  it('leaves changes to other files alone', () => {
    // A path-limited stash is what makes this true; a bare `git stash` would
    // have swept keep.txt away too.
    write('keep.txt', 'keep edited\n');
    write('drop.txt', 'drop edited\n');

    git(buildDiscardCommand(['drop.txt'], 'label', { keepIndex: true }).args);

    expect(read('keep.txt')).toContain('keep edited');
    expect(read('drop.txt')).toContain('drop original');
  });

  it('recovers a discarded untracked file', () => {
    write('new.txt', 'brand new\n');

    git(buildDiscardCommand(['new.txt'], 'label', { keepIndex: false }).args);
    expect(existsSync(join(repo, 'new.txt'))).toBe(false);

    git(buildStashApplyCommand('stash@{0}', { pop: true }).args);
    expect(read('new.txt')).toContain('brand new');
  });

  it('records the label so the UI can name the stash', () => {
    write('drop.txt', 'edited\n');
    git(
      buildDiscardCommand(['drop.txt'], 'krakenless: discarded 2026-08-20', {
        keepIndex: true,
      }).args,
    );
    expect(git(['stash', 'list'])).toContain('krakenless: discarded 2026-08-20');
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
