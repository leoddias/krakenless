import { describe, expect, it } from 'vitest';
import { GitError } from '../errors';
import { buildRepoInfo, parseRepoProbe, parseToplevel } from './repo';
import {
  buildHeadOidCommand,
  buildRepoProbeCommand,
  buildToplevelCommand,
} from '../commands/repo';

describe('repo command builders', () => {
  it('probes git dir and bare-ness without --show-toplevel', () => {
    // Verified against git 2.39: adding --show-toplevel makes the whole
    // command exit 128 in a bare repository.
    expect(buildRepoProbeCommand().args).toEqual([
      'rev-parse',
      '--absolute-git-dir',
      '--is-bare-repository',
    ]);
  });

  it('asks for the worktree root separately', () => {
    expect(buildToplevelCommand().args).toEqual(['rev-parse', '--show-toplevel']);
  });

  it('uses no flag newer than git 2.13, and never --path-format', () => {
    // rev-parse echoes unknown flags to stdout and exits 0, so any flag the
    // user's git predates silently corrupts the output instead of failing.
    // --path-format specifically (git 2.31) broke opening on older gits.
    for (const build of [buildRepoProbeCommand, buildToplevelCommand]) {
      expect(build().args).not.toContain('--path-format=absolute');
    }
  });

  it('verifies HEAD quietly so an empty repo is not noisy', () => {
    expect(buildHeadOidCommand().args).toEqual([
      'rev-parse',
      '--verify',
      '--quiet',
      'HEAD',
    ]);
  });
});

describe('parseRepoProbe', () => {
  it('parses a normal repository', () => {
    expect(parseRepoProbe('C:/repos/app/.git\nfalse\n')).toEqual({
      gitDir: 'C:/repos/app/.git',
      bare: false,
    });
  });

  it('parses a bare repository', () => {
    expect(parseRepoProbe('/srv/app.git\ntrue\n')).toEqual({
      gitDir: '/srv/app.git',
      bare: true,
    });
  });

  it('handles CRLF output', () => {
    expect(parseRepoProbe('/srv/app/.git\r\nfalse\r\n').gitDir).toBe('/srv/app/.git');
  });

  it('normalizes separators only for Windows paths', () => {
    expect(parseRepoProbe('C:\\repos\\app\\.git\nfalse\n').gitDir).toBe(
      'C:/repos/app/.git',
    );
    // A backslash is a legal POSIX filename character — rewriting it would
    // invent a path git never reported.
    expect(parseRepoProbe('/srv/we\\ird/.git\nfalse\n').gitDir).toBe('/srv/we\\ird/.git');
  });

  it('keeps significant leading and trailing spaces', () => {
    expect(parseRepoProbe('/srv/ app /.git\nfalse\n').gitDir).toBe('/srv/ app /.git');
  });

  it('refuses output with an unexpected line count instead of guessing', () => {
    // A worktree whose name contains a newline yields extra lines; silently
    // taking the first two would point every later command at another repo.
    expect(() => parseRepoProbe('/home/u/we\nird/.git\nfalse\n')).toThrow(GitError);
    expect(() => parseRepoProbe('/srv/app/.git\n')).toThrow(/Expected 2 line/);
    expect(() => parseRepoProbe('')).toThrow(GitError);
  });

  it('names the unsupported flag when an old git echoes it back', () => {
    // git < 2.31 echoed `--path-format=absolute` as an extra stdout line and
    // exited 0 — the user-visible bug was a cryptic "Expected 2 line(s), got 3".
    expect(() =>
      parseRepoProbe('--path-format=absolute\nC:/repos/app/.git\nfalse\n'),
    ).toThrow(/does not support --path-format=absolute/);
    // A `--` on a *later* line is a path fragment (newline in the directory
    // name), not an echoed flag — that must stay a plain line-count error.
    expect(() => parseRepoProbe('/home/u/proj\n--weird/.git\nfalse\n')).toThrow(
      /Expected 2 line/,
    );
  });

  it('refuses a bare flag that is not a boolean', () => {
    expect(() => parseRepoProbe('/srv/app/.git\nmaybe\n')).toThrow(/Unexpected output/);
  });
});

describe('parseToplevel', () => {
  it('parses one path', () => {
    expect(parseToplevel('C:/repos/app\n')).toBe('C:/repos/app');
  });

  it('keeps a path containing spaces intact', () => {
    expect(parseToplevel('C:/My Repos/app\n')).toBe('C:/My Repos/app');
  });

  it('rejects extra lines', () => {
    expect(() => parseToplevel('/home/u/we\nird\n')).toThrow(GitError);
  });

  it('rejects empty output', () => {
    expect(() => parseToplevel('\n')).toThrow(GitError);
  });
});

describe('buildRepoInfo', () => {
  it('assembles the probe results', () => {
    expect(
      buildRepoInfo({
        root: '/srv/app',
        gitDir: '/srv/app/.git',
        bare: false,
        empty: true,
      }),
    ).toEqual({ root: '/srv/app', gitDir: '/srv/app/.git', bare: false, empty: true });
  });
});
