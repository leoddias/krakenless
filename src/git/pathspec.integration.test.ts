/**
 * A pathspec too long for the command line, against the real git binary.
 *
 * The claim under test is not "the arguments look right" but "git accepts a
 * NUL-separated list on stdin for these three subcommands, and treats it
 * literally". `--literal-pathspecs` is a global flag; whether it reaches a
 * pathspec *file* is exactly the kind of thing only git can answer, and the
 * file name with a `*` below is what checks it.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildStageCommand, buildUnstageCommand } from './commands/stage';
import type { GitCommand } from './types';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let repo: string;

/** Runs a built command the way the runner does: arguments, plus its stdin. */
function run(command: GitCommand): string {
  return execFileSync('git', ['--no-pager', '--literal-pathspecs', ...command.args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    ...(command.stdin === undefined ? {} : { input: command.stdin }),
  });
}

function git(args: string[]): string {
  return run({ args });
}

/** Well past the 32,767-character command line Windows allows. */
const COUNT = 5000;

function paths(): string[] {
  return Array.from({ length: COUNT }, (_, i) => `out/file-${String(i)}.json`);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'krakenless-pathspec-'));
  git(['init', '--quiet']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'core.autocrlf', 'false']);
  writeFileSync(join(repo, 'seed.txt'), 'seed\n');
  git(['add', 'seed.txt']);
  git(['commit', '--quiet', '--message', 'seed']);

  mkdirSync(join(repo, 'out'));
  for (const path of paths()) writeFileSync(join(repo, path), '{}\n');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('a pathspec on stdin, against real git', () => {
  it('stages and unstages thousands of files', () => {
    run(buildStageCommand(paths()));
    expect(
      git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean),
    ).toHaveLength(COUNT);

    run(buildUnstageCommand(paths()));
    expect(git(['diff', '--cached', '--name-only']).trim()).toBe('');
  });

  it('reads the list literally, so a glob in a file name is that file', () => {
    // A path named `out/*.json` must select one file, not every file in
    // `out/`. `--literal-pathspecs` is what makes that true on the command
    // line; this is what shows it holds for a pathspec file as well.
    // Brackets, because `*` is not a legal file name on Windows. As a glob,
    // `file-[0-9].json` would match ten files; literally, it is one.
    writeFileSync(join(repo, 'out', 'file-[0-9].json'), 'literal\n');

    // The odd one plus enough files to need stdin, none of which the glob
    // reading would add — so the count alone tells the two readings apart.
    const rest = paths()
      .filter((path) => !/file-\d\.json$/.test(path))
      .slice(0, 2500);
    run(buildStageCommand(['out/file-[0-9].json', ...rest]));

    const staged = git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
    expect(staged).toContain('out/file-[0-9].json');
    expect(staged).not.toContain('out/file-0.json');
    expect(staged).toHaveLength(rest.length + 1);
  });
});
