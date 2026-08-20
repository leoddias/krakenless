import { describe, expect, it } from 'vitest';
import { parseBranches, parseRemotes, parseStashes, parseTracking } from './branch';
import { GitError } from '../errors';
import {
  BRANCH_FORMAT,
  buildBranchListCommand,
  buildCheckoutRevisionCommand,
  buildCreateBranchCommand,
  buildDeleteBranchCommand,
  buildSwitchCommand,
  buildSwitchNewCommand,
} from '../commands/branch';

const NUL = '\u0000';

/** Builds a branch record in the same field order as BRANCH_FORMAT. */
function branchRecord(fields: string[]): string {
  return fields.join(NUL);
}

describe('branch builders', () => {
  it('asks for the full refname first so local and remote can be told apart', () => {
    expect(BRANCH_FORMAT.split('%00')[0]).toBe('%(refname)');
  });

  it('lists only local branches by default', () => {
    expect(buildBranchListCommand().args).toEqual([
      'for-each-ref',
      `--format=${BRANCH_FORMAT}`,
      'refs/heads',
    ]);
    expect(buildBranchListCommand({ includeRemotes: true }).args).toContain(
      'refs/remotes',
    );
  });

  it('validates names so a branch called --force cannot become an option', () => {
    expect(() => buildCreateBranchCommand('--force')).toThrow(GitError);
    expect(() => buildSwitchCommand('-D')).toThrow(GitError);
    expect(() => buildDeleteBranchCommand('--all', { force: true })).toThrow(GitError);
  });

  it('prefers the safe delete and only forces when asked', () => {
    expect(buildDeleteBranchCommand('topic', { force: false }).args).toEqual([
      'branch',
      '-d',
      'topic',
    ]);
    expect(buildDeleteBranchCommand('topic', { force: true }).args).toEqual([
      'branch',
      '-D',
      'topic',
    ]);
    expect(buildDeleteBranchCommand('topic', { force: false }).destructive).toBe(true);
  });

  it('switches without forcing, so local edits are never clobbered', () => {
    const args = buildSwitchCommand('main').args;
    expect(args).toEqual(['switch', 'main']);
    expect(args).not.toContain('--force');
    expect(args).not.toContain('--discard-changes');
  });

  it('creates and switches in one step, with an optional start point', () => {
    expect(buildSwitchNewCommand('topic', 'main').args).toEqual([
      'switch',
      '--create',
      'topic',
      'main',
    ]);
  });

  it('detaches explicitly when checking out a commit', () => {
    expect(buildCheckoutRevisionCommand('9f1c2ab').args).toEqual([
      'switch',
      '--detach',
      '9f1c2ab',
    ]);
  });
});

describe('parseTracking', () => {
  it.each([
    ['', { ahead: 0, behind: 0, gone: false }],
    ['[ahead 2]', { ahead: 2, behind: 0, gone: false }],
    ['[behind 3]', { ahead: 0, behind: 3, gone: false }],
    ['[ahead 2, behind 3]', { ahead: 2, behind: 3, gone: false }],
    ['[gone]', { ahead: 0, behind: 0, gone: true }],
  ])('parses %j', (input, expected) => {
    expect(parseTracking(input)).toEqual(expected);
  });
});

describe('parseBranches', () => {
  // Captured from git 2.39.2: %(HEAD) is `*` for the current branch and a
  // single space for every other one.
  const REAL = [
    branchRecord(['refs/heads/feature/x', 'feature/x', 'bf6ad6f', ' ', '', '']),
    branchRecord(['refs/heads/master', 'master', 'bf6ad6f', '*', '', '']),
  ].join('\n');

  it('reads the current branch from the HEAD marker', () => {
    const branches = parseBranches(REAL);
    expect(branches.map((b) => b.name)).toEqual(['feature/x', 'master']);
    expect(branches.find((b) => b.current)?.name).toBe('master');
  });

  it('does not call a local branch with a slash a remote branch', () => {
    // `feature/x` is local; only the refs/remotes/ prefix means remote.
    expect(parseBranches(REAL).find((b) => b.name === 'feature/x')?.remote).toBe(false);
  });

  it('flags real remote branches', () => {
    const record = branchRecord([
      'refs/remotes/origin/main',
      'origin/main',
      'abc1234',
      ' ',
      '',
      '',
    ]);
    expect(parseBranches(record)[0]?.remote).toBe(true);
  });

  it('reads upstream and ahead/behind counts', () => {
    const record = branchRecord([
      'refs/heads/main',
      'main',
      'abc1234',
      '*',
      'origin/main',
      '[ahead 2, behind 1]',
    ]);
    expect(parseBranches(record)[0]).toMatchObject({
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
    });
  });

  it('drops an upstream that is gone rather than offering a push to it', () => {
    const record = branchRecord([
      'refs/heads/main',
      'main',
      'abc1234',
      '*',
      'origin/main',
      '[gone]',
    ]);
    expect(parseBranches(record)[0]?.upstream).toBeUndefined();
  });

  it('handles CRLF and blank lines', () => {
    const record = `${branchRecord(['refs/heads/main', 'main', 'abc', '*', '', ''])}\r\n\r\n`;
    expect(parseBranches(record)).toHaveLength(1);
  });

  it('throws on a record with the wrong field count', () => {
    expect(() => parseBranches(`main${NUL}abc`)).toThrow(GitError);
  });

  it('throws on an empty name or oid', () => {
    expect(() =>
      parseBranches(branchRecord(['refs/heads/x', '', 'abc', '*', '', ''])),
    ).toThrow(/missing a name/);
  });
});

describe('parseRemotes', () => {
  // Verbatim from git 2.39.2 (tab-separated, direction in parentheses).
  const REAL =
    'origin\thttps://example.com/r.git (fetch)\norigin\thttps://example.com/r.git (push)\n';

  it('merges the fetch and push lines into one remote', () => {
    expect(parseRemotes(REAL)).toEqual([
      {
        name: 'origin',
        fetchUrl: 'https://example.com/r.git',
        pushUrl: 'https://example.com/r.git',
      },
    ]);
  });

  it('keeps different push and fetch URLs apart', () => {
    const output =
      'origin\thttps://a.example/r.git (fetch)\norigin\tssh://b.example/r.git (push)\n';
    expect(parseRemotes(output)[0]).toMatchObject({
      fetchUrl: 'https://a.example/r.git',
      pushUrl: 'ssh://b.example/r.git',
    });
  });

  it('handles a URL containing spaces and parentheses', () => {
    const output = 'origin\tC:/my repos/r (mirror).git (fetch)\n';
    expect(parseRemotes(output)[0]?.fetchUrl).toBe('C:/my repos/r (mirror).git');
  });

  it('returns nothing for a repository with no remotes', () => {
    expect(parseRemotes('')).toEqual([]);
  });

  it('throws rather than guessing at an unrecognized line', () => {
    expect(() => parseRemotes('garbage\n')).toThrow(GitError);
  });
});

describe('parseStashes', () => {
  // Verbatim from git 2.39.2: `stash list -z` separates fields *and* records
  // with NUL, and terminates the last one too.
  const REAL =
    `stash@{0}${NUL}7e499fef1a7efe7533381f6146fd5d7c79d4005f${NUL}2026-08-20T01:49:53-03:00${NUL}On master: second${NUL}` +
    `stash@{1}${NUL}da59e9a9679c49b95b1a6b481583fa1cccfed9f0${NUL}2026-08-20T01:49:52-03:00${NUL}On master: first stash${NUL}`;

  it('reads every entry, newest first', () => {
    const stashes = parseStashes(REAL);
    expect(stashes).toHaveLength(2);
    expect(stashes[0]).toMatchObject({
      ref: 'stash@{0}',
      index: 0,
      message: 'On master: second',
      branch: 'master',
      date: '2026-08-20T01:49:53-03:00',
    });
    expect(stashes[1]?.index).toBe(1);
  });

  it('returns nothing when there are no stashes', () => {
    expect(parseStashes('')).toEqual([]);
  });

  it('keeps a message containing a colon intact', () => {
    const record = `stash@{0}${NUL}1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d${NUL}2026-08-20T01:00:00-03:00${NUL}On main: fix: thing${NUL}`;
    expect(parseStashes(record)[0]).toMatchObject({
      branch: 'main',
      message: 'On main: fix: thing',
    });
  });

  it('handles a WIP stash created without a message', () => {
    const record = `stash@{0}${NUL}1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d${NUL}2026-08-20T01:00:00-03:00${NUL}WIP on main: abc1234 subject${NUL}`;
    expect(parseStashes(record)[0]?.branch).toBe('main');
  });

  it('throws on a truncated record instead of inventing fields', () => {
    expect(() =>
      parseStashes(`stash@{0}${NUL}1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d${NUL}`),
    ).toThrow(/not a multiple/);
  });

  it('refuses a malformed object id', () => {
    // The oid is handed back to the user as `git stash apply <oid>`; an
    // abbreviated or garbled one sends them to a command that cannot work.
    const record = `stash@{0}${NUL}not-an-oid${NUL}2026-08-20T01:00:00-03:00${NUL}msg${NUL}`;
    expect(() => parseStashes(record)).toThrow(/malformed object id/);
  });

  it('throws on an unrecognized stash ref', () => {
    const record = `refs/stash${NUL}1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d${NUL}2026-08-20T01:00:00-03:00${NUL}msg${NUL}`;
    expect(() => parseStashes(record)).toThrow(/Unrecognized stash ref/);
  });
});
