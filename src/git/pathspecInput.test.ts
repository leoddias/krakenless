import { describe, expect, it } from 'vitest';
import { PATHSPEC_ARGV_LIMIT, pathspecInput } from './argsafety';
import { buildStageCommand, buildUnstageCommand } from './commands/stage';
import { isDestructive } from './destructive';
import { GitError } from './errors';

/** Enough paths to overflow the argument budget several times over. */
function manyPaths(count = 3000): string[] {
  return Array.from({ length: count }, (_, i) => `graphify-out/file-${String(i)}.json`);
}

describe('pathspecInput', () => {
  it('puts a short list after -- like it always did', () => {
    expect(pathspecInput(['a.txt', 'src/b.ts'])).toEqual({
      args: ['--', 'a.txt', 'src/b.ts'],
    });
  });

  it('moves a long list onto stdin, NUL-separated', () => {
    // 4,524 untracked files after a build: "Discard all" used to fail with
    // "could not start git", because Windows would not start a process with a
    // command line that long.
    const paths = manyPaths();
    const input = pathspecInput(paths);

    expect(input.args).toEqual(['--pathspec-from-file=-', '--pathspec-file-nul']);
    expect(input.stdin).toBe(paths.join('\0'));
  });

  it('switches on total length, not count, so a few very long paths also fit', () => {
    const deep = `${'a-long-directory-name/'.repeat(20)}file.ts`;
    const count = Math.ceil(PATHSPEC_ARGV_LIMIT / deep.length) + 1;
    const input = pathspecInput(Array.from({ length: count }, () => deep));
    expect(input.stdin).toBeDefined();
  });

  it('stays on the command line right up to the budget', () => {
    const path = 'x'.repeat(99);
    // 80 × (99 + 1) = 8,000, exactly the budget.
    expect(pathspecInput(Array.from({ length: 80 }, () => path)).stdin).toBeUndefined();
  });

  it('checks every path the same way whichever route it takes', () => {
    expect(() => pathspecInput([])).toThrow(GitError);
    expect(() => pathspecInput([...manyPaths(), '/etc/passwd'])).toThrow(GitError);
    expect(() => pathspecInput([...manyPaths(), '../outside'])).toThrow(GitError);
  });

  it('refuses a NUL, which would split one path into two on stdin', () => {
    expect(() => pathspecInput([...manyPaths(), 'a\0b'])).toThrow(GitError);
  });
});

describe('the builders that take a path list', () => {
  const paths = manyPaths();

  it('stage carries the list on stdin when it is long', () => {
    const command = buildStageCommand(paths);
    expect(command.args).toEqual([
      'add',
      '--pathspec-from-file=-',
      '--pathspec-file-nul',
    ]);
    expect(command.stdin).toBe(paths.join('\0'));
  });

  it('unstage carries the list on stdin and is still destructive', () => {
    const command = buildUnstageCommand(paths);
    expect(command.args).toEqual([
      'restore',
      '--staged',
      '--pathspec-from-file=-',
      '--pathspec-file-nul',
    ]);
    expect(command.stdin).toBe(paths.join('\0'));
    expect(command.destructive).toBe(true);
    expect(isDestructive(command.args)).toBe(true);
  });
});
