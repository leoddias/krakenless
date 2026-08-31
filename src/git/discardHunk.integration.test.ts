/**
 * Integration tests for discarding a single hunk, against the real git binary.
 *
 * `docs/CONVENTIONS.md` requires every destructive path to prove its recovery
 * route works. This one is the sharpest in the app: it removes an edit git was
 * never told about, so the blob backup is the *only* way back and a test that
 * merely asserted "the lines are gone" would be checking the easy half.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildBackupBlobCommand,
  buildDiscardHunkCheckCommand,
  buildDiscardHunkCommand,
} from './commands/stage';
import { parseDiff } from './parsers/diff';
import { serializeHunks } from './patch';

import type { Hunk, ParsedFileDiff } from './types';

const LF = '\n';

/** Every discard patch is built for the worktree; the index shape differs. */
function reversePatch(file: ParsedFileDiff, hunks: Hunk[]): string {
  return serializeHunks(file, hunks, 'worktree');
}

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

function worktreeDiff() {
  return parseDiff(git(['diff', '--no-color', '--no-ext-diff', '--full-index', '-U3']));
}

/** Ten numbered lines, so two edits land far enough apart to be two hunks. */
function seedLines(): string {
  return `${Array.from({ length: 12 }, (_, i) => `line ${String(i + 1)}`).join('\n')}\n`;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'krakenless-discard-hunk-'));
  git(['init', '--quiet']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'core.autocrlf', 'false']);
  write('a.txt', seedLines());
  git(['add', '.']);
  git(['commit', '--quiet', '--message', 'seed']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** Edits the first and last lines, which git reports as two separate hunks. */
function makeTwoHunks(): void {
  const lines = seedLines().split('\n');
  lines[0] = 'line 1 EDITED';
  lines[11] = 'line 12 EDITED';
  write('a.txt', lines.join('\n'));
}

describe('discarding one hunk', () => {
  it('removes only the chosen hunk and leaves the other edit alone', () => {
    makeTwoHunks();
    const [file] = worktreeDiff();
    expect(file?.hunks).toHaveLength(2);

    const patch = reversePatch(file!, [file!.hunks[0]!]);
    git(buildDiscardHunkCommand({}).args, patch);

    // The first edit is gone from disk; the second is untouched. Reverting the
    // whole file would have been the easy, wrong implementation.
    expect(read('a.txt')).toContain('line 1\n');
    expect(read('a.txt')).not.toContain('line 1 EDITED');
    expect(read('a.txt')).toContain('line 12 EDITED');
  });

  it('is recoverable: the backup blob restores the file exactly', () => {
    // This is the test that makes discarding a hunk defensible at all.
    makeTwoHunks();
    const before = read('a.txt');
    const blobOid = git(buildBackupBlobCommand('a.txt').args).trim();

    const [file] = worktreeDiff();
    git(buildDiscardHunkCommand({}).args, reversePatch(file!, [file!.hunks[0]!]));
    expect(read('a.txt')).not.toBe(before);

    // What the in-app undo writes back: the blob's bytes, verbatim.
    write('a.txt', git(['cat-file', 'blob', blobOid]));
    expect(read('a.txt')).toBe(before);
  });

  it('backs the file up before the index, not from it', () => {
    // The hunk being discarded may never have been staged, so a backup taken
    // from the index would restore a file that never existed.
    makeTwoHunks();
    git(['add', 'a.txt']);
    write('a.txt', `${seedLines()}extra unstaged line\n`);

    const blobOid = git(buildBackupBlobCommand('a.txt').args).trim();
    expect(git(['cat-file', '-p', blobOid])).toContain('extra unstaged line');
  });

  it('changes nothing when the selection no longer matches the file', () => {
    // The dry run is what turns a stale selection into "nothing happened"
    // rather than a half-applied revert.
    makeTwoHunks();
    const [file] = worktreeDiff();
    const patch = reversePatch(file!, [file!.hunks[0]!]);

    write('a.txt', 'the file moved on entirely\n');
    expect(() => git(buildDiscardHunkCheckCommand({}).args, patch)).toThrow();
    expect(read('a.txt')).toBe('the file moved on entirely\n');
  });

  it('leaves the staged snapshot alone', () => {
    // No `--cached`: the discard is a working-tree operation, and a staged
    // change the user already chose must survive it.
    write('a.txt', seedLines().replace('line 1\n', 'line 1 STAGED\n'));
    git(['add', 'a.txt']);
    const staged = git(['show', ':a.txt']);

    const lines = read('a.txt').split('\n');
    lines[11] = 'line 12 EDITED';
    write('a.txt', lines.join('\n'));

    const [file] = worktreeDiff();
    git(buildDiscardHunkCommand({}).args, reversePatch(file!, file!.hunks));

    expect(git(['show', ':a.txt'])).toBe(staged);
    expect(read('a.txt')).not.toContain('line 12 EDITED');
  });
});

describe('what a one-hunk discard must not touch', () => {
  it('leaves the executable bit alone', () => {
    // The mode lines describe the file, not the hunk. Emitting them would have
    // `apply --reverse` chmod the file back — reverting a change the user never
    // selected, and one the content backup cannot restore.
    // Runs everywhere, Windows included. The mode difference is created in the
    // *index* rather than on disk: with `core.filemode` on, git compares the
    // index's 100755 against what it stats in the worktree, and NTFS — which
    // has no exec bit — reports 100644. A `chmod` on disk would have made this
    // a POSIX-only test, and the CI failure that prompted this fix was in
    // exactly the branch Windows never ran.
    git(['config', 'core.filemode', 'true']);
    // While the file is still clean: `update-index` is the plumbing form of
    // `git add`, so doing this *after* the edits would stage the very changes
    // this test needs to be unstaged — which is what broke it on macOS.
    git(['update-index', '--chmod=+x', 'a.txt']);
    makeTwoHunks();

    const [file] = worktreeDiff();
    // The fixture has to actually produce a mode change, or the assertions
    // below pass for the wrong reason.
    expect(file?.oldMode).toBe('100755');
    expect(file?.newMode).toBe('100644');

    const patch = reversePatch(file!, [file!.hunks[0]!]);
    expect(patch).not.toContain('old mode');
    git(buildDiscardHunkCommand({}).args, patch);

    // The hunk is gone and the exec bit is still there. Reverting the mode
    // would be reverting a change the user never selected — and the content
    // backup could not put it back.
    expect(read('a.txt')).not.toContain('line 1 EDITED');
    expect(git(['diff', '--summary'])).toContain('mode change');
  });

  it('discards the second hunk at its real position', () => {
    // The reverse apply matches the *new* side, so hunk 2's position must be
    // its parsed one — not the index path's offset-corrected number.
    const lines = seedLines().split(LF);
    lines.splice(1, 0, ...['inserted a', 'inserted b', 'inserted c']);
    lines[lines.length - 2] = 'line 12 EDITED';
    write('a.txt', lines.join(LF));

    const [file] = worktreeDiff();
    expect(file?.hunks.length).toBeGreaterThan(1);
    const last = file!.hunks[file!.hunks.length - 1]!;
    git(buildDiscardHunkCommand({}).args, reversePatch(file!, [last]));

    // The last edit is gone; the insertion at the top survived untouched.
    expect(read('a.txt')).not.toContain('line 12 EDITED');
    expect(read('a.txt')).toContain('inserted a');
  });
});
