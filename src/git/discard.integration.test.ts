/**
 * The whole-file discard against the real git binary, end to end: the backup,
 * the removal, and the way back.
 *
 * These tests run exactly the commands `discardPaths` builds, in its order,
 * and then **restore from the oids it reported** — with `git cat-file`, the
 * same read the Rust restore does. A backup whose oid is merely well-formed
 * is worthless; the bytes coming back identical is the point.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chunkPathspec } from './argsafety';
import {
  buildBackupBlobsCommand,
  buildRemoveUntrackedCommand,
  buildRestoreWorktreeCommand,
} from './commands/stage';
import type { GitCommand } from './types';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let repo: string;

/** Runs a built command the way the runner does: arguments, plus its stdin. */
function run(command: GitCommand, options: { binary?: boolean } = {}): string | Buffer {
  return execFileSync('git', ['--no-pager', '--literal-pathspecs', ...command.args], {
    cwd: repo,
    ...(options.binary === true ? {} : { encoding: 'utf8' as const }),
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    ...(command.stdin === undefined ? {} : { input: command.stdin }),
  });
}

function git(args: string[]): string {
  return run({ args }) as string;
}

function write(name: string, contents: string | Buffer): void {
  writeFileSync(join(repo, name), contents);
}

/** Backs the paths up and returns their oids, as `discardPaths` would. */
function backUp(paths: string[]): string[] {
  const out = run(buildBackupBlobsCommand(paths)) as string;
  return out.split('\n').filter((line) => line.length > 0);
}

/** The bytes of a backup blob, read the way the Rust restore reads them. */
function blob(oid: string): Buffer {
  return run({ args: ['cat-file', 'blob', oid] }, { binary: true }) as Buffer;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'krakenless-discard-'));
  git(['init', '--quiet']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  // Off, so what these tests see is what this code does, not what
  // `core.autocrlf=true` (the Git for Windows default) does underneath it.
  git(['config', 'core.autocrlf', 'false']);
  write('seed.txt', 'seed\n');
  git(['add', '.']);
  git(['commit', '--quiet', '--message', 'seed']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('the whole-file discard against real git', () => {
  it('brings back a tracked edit byte for byte, leaving the staged snapshot alone', () => {
    write('seed.txt', 'staged\n');
    git(['add', 'seed.txt']);
    // No trailing newline and a CRLF: the two things a text round trip loses.
    write('seed.txt', 'worktree\r\nedited');

    const [oid] = backUp(['seed.txt']);
    run(buildRestoreWorktreeCommand(['seed.txt']));

    expect(readFileSync(join(repo, 'seed.txt'), 'utf8')).toBe('staged\n');
    expect(git(['show', ':seed.txt'])).toBe('staged\n');
    expect(blob(oid ?? '').toString('utf8')).toBe('worktree\r\nedited');
  });

  it('brings back a removed untracked file, which exists nowhere else', () => {
    write('notes.txt', 'my notes\n');

    const [oid] = backUp(['notes.txt']);
    run(buildRemoveUntrackedCommand(['notes.txt']));

    expect(existsSync(join(repo, 'notes.txt'))).toBe(false);
    expect(blob(oid ?? '').toString('utf8')).toBe('my notes\n');
  });

  it('backs a binary up exactly, which is why the restore is not a text path', () => {
    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x1a,
    ]);
    write('logo.png', bytes);

    const [oid] = backUp(['logo.png']);
    run(buildRemoveUntrackedCommand(['logo.png']));

    expect(Buffer.compare(blob(oid ?? ''), bytes)).toBe(0);
  });

  it('restores a deleted tracked file from the index, with nothing to back up', () => {
    rmSync(join(repo, 'seed.txt'));

    run(buildRestoreWorktreeCommand(['seed.txt']));

    expect(readFileSync(join(repo, 'seed.txt'), 'utf8')).toBe('seed\n');
  });

  it('leaves the stash list and the graph alone', () => {
    write('seed.txt', 'edited\n');

    backUp(['seed.txt']);
    run(buildRestoreWorktreeCommand(['seed.txt']));

    expect(git(['stash', 'list'])).toBe('');
    expect(git(['log', '--oneline', '--all']).trim().split('\n')).toHaveLength(1);
  });

  it('keeps a path with a space intact through the round trip', () => {
    write('my notes.txt', 'spaced\n');

    const [oid] = backUp(['my notes.txt']);
    run(buildRemoveUntrackedCommand(['my notes.txt']));

    expect(existsSync(join(repo, 'my notes.txt'))).toBe(false);
    expect(blob(oid ?? '').toString('utf8')).toBe('spaced\n');
  });

  it('handles thousands of untracked files: one backup, chunked cleans', () => {
    const count = 3000;
    const paths = Array.from({ length: count }, (_, i) => `out/file-${String(i)}.json`);
    mkdirSync(join(repo, 'out'));
    for (const path of paths) write(path, `{"n":${String(path.length)}}\n`);

    const oids = backUp(paths);
    expect(oids).toHaveLength(count);
    const chunks = chunkPathspec(paths);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) run(buildRemoveUntrackedCommand(chunk));

    expect(existsSync(join(repo, 'out/file-0.json'))).toBe(false);
    expect(existsSync(join(repo, `out/file-${String(count - 1)}.json`))).toBe(false);
    expect(blob(oids[count - 1] ?? '').toString('utf8')).toBe(
      `{"n":${paths[count - 1]?.length ?? 0}}\n`,
    );
    expect(git(['stash', 'list'])).toBe('');
  });
});
