/**
 * Hunk staging under `core.autocrlf=true`.
 *
 * This is the Git for Windows default and what GitHub's Windows runners use, so
 * a large share of the target audience has it on. With it, the working tree
 * holds CRLF while the index and objects hold LF, and git converts on the way
 * in and out. Every other integration test pins it off so it can assert what
 * this code does to content; this file exists to find out whether the patch
 * round-trip survives the conversion, because a patch that does not is a patch
 * that stages something other than what the user selected.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseDiff } from './parsers/diff';
import { serializeFile, serializeHunks } from './patch';

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

/** The diff the app would parse: worktree against index, as the app asks for it. */
function worktreeDiff() {
  return parseDiff(git(['diff', '--no-color', '--no-ext-diff', '--full-index', '-U3']));
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'krakenless-autocrlf-'));
  git(['init', '--quiet']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  // The point of this file.
  git(['config', 'core.autocrlf', 'true']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('hunk staging with core.autocrlf=true', () => {
  it('stages a whole file without changing what lands in the index', () => {
    // With autocrlf the worktree holds CRLF and the index holds LF. A patch
    // built from the diff must produce the same index content `git add` would.
    write('f.txt', 'a\r\nb\r\nc\r\n');
    git(['add', 'f.txt']);
    git(['commit', '--quiet', '--message', 'seed']);
    write('f.txt', 'a\r\nB\r\nc\r\n');

    const [file] = worktreeDiff();
    expect(file).toBeDefined();
    git(['apply', '--cached', '--unidiff-zero', '-'], serializeFile(file!));

    // Index content is normalised to LF by git itself; the app must not fight it.
    expect(git(['show', ':f.txt'])).toBe('a\nB\nc\n');
    // And the working tree the user is looking at is untouched.
    expect(read('f.txt')).toBe('a\r\nB\r\nc\r\n');
  });

  it('stages one hunk out of several, leaving the rest unstaged', () => {
    const original = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\r\n');
    write('f.txt', `${original}\r\n`);
    git(['add', 'f.txt']);
    git(['commit', '--quiet', '--message', 'seed']);

    const edited = original
      .split('\r\n')
      .map((line, i) => (i === 2 || i === 20 ? `${line} CHANGED` : line))
      .join('\r\n');
    write('f.txt', `${edited}\r\n`);

    const [file] = worktreeDiff();
    expect(file?.hunks).toHaveLength(2);

    const patch = serializeHunks(file!, [file!.hunks[0]!]);
    git(['apply', '--cached', '--check', '--unidiff-zero', '-'], patch);
    git(['apply', '--cached', '--unidiff-zero', '-'], patch);

    const staged = git(['show', ':f.txt']);
    expect(staged).toContain('line 3 CHANGED');
    expect(staged).not.toContain('line 21 CHANGED');
  });

  it('matches what `git add` would have staged, byte for byte', () => {
    // The strongest form of the claim: whatever conversion git applies, the
    // app's patch path and the plain `add` path must agree.
    write('f.txt', 'one\r\ntwo\r\n');
    git(['add', 'f.txt']);
    git(['commit', '--quiet', '--message', 'seed']);
    write('f.txt', 'one\r\nTWO\r\nthree\r\n');

    const [file] = worktreeDiff();
    git(['apply', '--cached', '--unidiff-zero', '-'], serializeFile(file!));
    const viaPatch = git(['show', ':f.txt']);

    git(['reset', '--quiet', 'HEAD', '--', 'f.txt']);
    git(['add', 'f.txt']);
    const viaAdd = git(['show', ':f.txt']);

    expect(viaPatch).toBe(viaAdd);
  });

  it('handles a file that git is told to leave alone via .gitattributes', () => {
    // `-text` opts a path out of conversion; the app must not assume every file
    // in a repository follows the global setting.
    write('.gitattributes', 'binaryish.txt -text\n');
    write('binaryish.txt', 'x\r\ny\r\n');
    git(['add', '.']);
    git(['commit', '--quiet', '--message', 'seed']);
    write('binaryish.txt', 'x\r\nY\r\n');

    const [file] = worktreeDiff();
    expect(file).toBeDefined();
    git(['apply', '--cached', '--unidiff-zero', '-'], serializeFile(file!));

    // No conversion for this path: CRLF survives into the index.
    expect(git(['show', ':binaryish.txt'])).toBe('x\r\nY\r\n');
  });
});
