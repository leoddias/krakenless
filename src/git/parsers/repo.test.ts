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
      '--path-format=absolute',
      '--absolute-git-dir',
      '--is-bare-repository',
    ]);
  });

  it('asks for the worktree root separately', () => {
    expect(buildToplevelCommand().args).toEqual([
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
    ]);
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
