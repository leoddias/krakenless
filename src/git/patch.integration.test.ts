/**
 * Integration tests: the patch serializer against the real git binary.
 *
 * Unit tests can only prove the serializer produces the string we expect.
 * Whether git *accepts* that string, and stages exactly the selected hunks, is
 * a question only git can answer — and it is the question that decides whether
 * a user loses work. Every test here creates a disposable repository under the
 * OS temp directory and throws it away afterwards.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseDiff } from './parsers/diff';
import { serializeFile, serializeHunks } from './patch';

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

/** The diff git would show for the working tree, parsed with our own parser. */
function worktreeDiff() {
  return parseDiff(git(['diff', '--no-color', '--no-ext-diff', '--full-index', '-U3']));
}

function stagedContent(path: string): string {
  return git(['show', `:${path}`]);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'krakenless-patch-'));
  git(['init', '--quiet']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  // Line-ending conversion off: these tests assert what *this code* does to
  // content, and `core.autocrlf=true` — the Git for Windows default, and what
  // GitHub's Windows runners use — would have git rewrite it underneath them.
  // The autocrlf=true behaviour is covered separately and deliberately.
  git(['config', 'core.autocrlf', 'false']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('serializeHunks against real git', () => {
  it('stages a single hunk out of several, leaving the others unstaged', () => {
    // The core partial-staging promise: what the user did not select must not
    // reach the index.
    const original = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    write('f.txt', `${original}\n`);
    git(['add', 'f.txt']);
    git(['commit', '--quiet', '--message', 'seed']);

    const edited = original
      .split('\n')
      .map((line, i) => (i === 2 || i === 20 ? `${line} CHANGED` : line))
      .join('\n');
    write('f.txt', `${edited}\n`);

    const [file] = worktreeDiff();
    expect(file?.hunks).toHaveLength(2);

    const patch = serializeHunks(file!, [file!.hunks[0]!]);
    git(['apply', '--cached', '--check', '--unidiff-zero', '-'], patch);
    git(['apply', '--cached', '--unidiff-zero', '-'], patch);

    const staged = stagedContent('f.txt');
    expect(staged).toContain('line 3 CHANGED');
    expect(staged).not.toContain('line 21 CHANGED');
    // The working tree still has both edits — staging never touches it.
    expect(git(['diff', '--name-only'])).toContain('f.txt');
  });

  it('stages the second hunk alone, with the offset corrected', () => {
    // The second hunk sits at a different new-side offset once the first is not
    // applied; a wrong offset writes the change into the wrong place.
    const original = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    write('f.txt', `${original}\n`);
    git(['add', 'f.txt']);
    git(['commit', '--quiet', '--message', 'seed']);

    const edited = original
      .split('\n')
      .map((line, i) => (i === 2 || i === 20 ? `${line} CHANGED` : line))
      .join('\n');
    write('f.txt', `${edited}\n`);

    const [file] = worktreeDiff();
    const patch = serializeHunks(file!, [file!.hunks[1]!]);
    git(['apply', '--cached', '--unidiff-zero', '-'], patch);

    const staged = stagedContent('f.txt');
    expect(staged).toContain('line 21 CHANGED');
    expect(staged).not.toContain('line 3 CHANGED');
    expect(staged.split('\n').filter(Boolean)).toHaveLength(30);
  });

  it('round-trips a whole file, matching what git add would stage', () => {
    write('f.txt', 'a\nb\nc\n');
    git(['add', 'f.txt']);
    git(['commit', '--quiet', '--message', 'seed']);
    write('f.txt', 'a\nB\nc\nd\n');

    const [file] = worktreeDiff();
    git(['apply', '--cached', '--unidiff-zero', '-'], serializeFile(file!));

    expect(stagedContent('f.txt')).toBe('a\nB\nc\nd\n');
  });

  it('preserves CRLF content exactly', () => {
    // Rewriting line endings while staging silently rewrites the user's file.
    write('crlf.txt', 'x\r\ny\r\nz\r\n');
    git(['add', 'crlf.txt']);
    git(['commit', '--quiet', '--message', 'seed']);
    write('crlf.txt', 'x\r\nY\r\nz\r\n');

    const [file] = worktreeDiff();
    git(['apply', '--cached', '--unidiff-zero', '-'], serializeFile(file!));

    expect(stagedContent('crlf.txt')).toBe('x\r\nY\r\nz\r\n');
  });

  it('handles a file that gains a trailing newline', () => {
    write('nonl.txt', 'no trailing');
    git(['add', 'nonl.txt']);
    git(['commit', '--quiet', '--message', 'seed']);
    write('nonl.txt', 'no trailing\n');

    const [file] = worktreeDiff();
    git(['apply', '--cached', '--unidiff-zero', '-'], serializeFile(file!));

    expect(stagedContent('nonl.txt')).toBe('no trailing\n');
  });

  it('handles a file that loses its trailing newline', () => {
    write('nonl.txt', 'has trailing\n');
    git(['add', 'nonl.txt']);
    git(['commit', '--quiet', '--message', 'seed']);
    write('nonl.txt', 'has trailing');

    const [file] = worktreeDiff();
    git(['apply', '--cached', '--unidiff-zero', '-'], serializeFile(file!));

    expect(stagedContent('nonl.txt')).toBe('has trailing');
  });

  it('handles a pure insertion at the start of a file', () => {
    write('f.txt', 'b\nc\n');
    git(['add', 'f.txt']);
    git(['commit', '--quiet', '--message', 'seed']);
    write('f.txt', 'a\nb\nc\n');

    const [file] = worktreeDiff();
    git(['apply', '--cached', '--unidiff-zero', '-'], serializeFile(file!));

    expect(stagedContent('f.txt')).toBe('a\nb\nc\n');
  });

  it('handles deleting every line of a file', () => {
    write('f.txt', 'a\nb\nc\n');
    git(['add', 'f.txt']);
    git(['commit', '--quiet', '--message', 'seed']);
    write('f.txt', '');

    const [file] = worktreeDiff();
    git(['apply', '--cached', '--unidiff-zero', '-'], serializeFile(file!));

    expect(stagedContent('f.txt')).toBe('');
  });

  it('handles a path containing a space and unicode', () => {
    write('my café.txt', 'a\n');
    git(['add', 'my café.txt']);
    git(['commit', '--quiet', '--message', 'seed']);
    write('my café.txt', 'A\n');

    const [file] = parseDiff(
      git(['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-U3']),
    );
    git(['apply', '--cached', '--unidiff-zero', '-'], serializeFile(file!));

    expect(stagedContent('my café.txt')).toBe('A\n');
  });

  it('produces a patch git rejects rather than half-applies when the file moved on', () => {
    // The user selects a hunk, then the file changes underneath. `--check` must
    // fail; a patch that half-applies would leave the index inconsistent.
    write('f.txt', 'a\nb\nc\n');
    git(['add', 'f.txt']);
    git(['commit', '--quiet', '--message', 'seed']);
    write('f.txt', 'a\nB\nc\n');

    const [file] = worktreeDiff();
    const patch = serializeFile(file!);

    // Someone else rewrites the file completely.
    write('f.txt', 'totally different\n');
    git(['add', 'f.txt']);

    expect(() =>
      git(['apply', '--cached', '--check', '--unidiff-zero', '-'], patch),
    ).toThrow();
    expect(stagedContent('f.txt')).toBe('totally different\n');
  });
});
