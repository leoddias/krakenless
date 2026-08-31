import { GitError } from '../errors';
import type { RepoInfo } from '../types';

/**
 * Splits git output into exactly `expected` lines.
 *
 * Deliberately strict: `rev-parse` has no NUL-separated mode, and a path may
 * legally contain a newline, leading spaces, or a backslash. Being lenient
 * here (trimming, dropping blanks) would turn such a path into a *different*,
 * plausible-looking path — which later becomes the working directory of write
 * commands. A loud parse error is the only safe failure mode.
 */
function exactLines(stdout: string, expected: number, args: string[]): string[] {
  const lines = stdout.split('\n').map((line) => line.replace(/\r$/, ''));
  // Git terminates the last line, which leaves one trailing empty element.
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  if (lines.length !== expected) {
    // `rev-parse` echoes flags it does not recognize to stdout and still
    // exits 0, so an old git turns each unsupported flag into an extra output
    // line. Name that cause instead of reporting a bare line count. Only the
    // first line qualifies: git echoes flags in argument order, before any
    // value — a later `--` line is a path fragment, not a flag.
    const echoed = lines[0];
    if (lines.length > expected && echoed !== undefined && echoed.startsWith('--')) {
      throw new GitError(
        'parse-failed',
        `This git does not support ${echoed} — please update git`,
        { args },
      );
    }
    throw new GitError(
      'parse-failed',
      `Expected ${expected} line(s) from git rev-parse, got ${lines.length}`,
      { args },
    );
  }
  return lines;
}

/**
 * Normalizes separators only for Windows-shaped paths (`C:\...`). On POSIX a
 * backslash is a legal filename character, so rewriting it would invent a path
 * that is not the one git reported.
 */
function normalizePath(path: string): string {
  return /^[A-Za-z]:[\\/]/.test(path) ? path.replace(/\\/g, '/') : path;
}

/** Parses the two lines of {@link buildRepoProbeCommand}. */
export function parseRepoProbe(stdout: string): { gitDir: string; bare: boolean } {
  const [gitDir, bare] = exactLines(stdout, 2, ['rev-parse', '--absolute-git-dir']);
  if (
    gitDir === undefined ||
    gitDir.length === 0 ||
    (bare !== 'true' && bare !== 'false')
  ) {
    throw new GitError('parse-failed', 'Unexpected output from git rev-parse', {
      args: ['rev-parse', '--is-bare-repository'],
    });
  }
  return { gitDir: normalizePath(gitDir), bare: bare === 'true' };
}

/** Parses the single line of {@link buildToplevelCommand}. */
export function parseToplevel(stdout: string): string {
  const [root] = exactLines(stdout, 1, ['rev-parse', '--show-toplevel']);
  if (root === undefined || root.length === 0) {
    throw new GitError('parse-failed', 'git reported an empty worktree root', {
      args: ['rev-parse', '--show-toplevel'],
    });
  }
  return normalizePath(root);
}

/** Assembles the pieces the two probes returned. */
export function buildRepoInfo(parts: {
  root: string;
  gitDir: string;
  bare: boolean;
  empty: boolean;
}): RepoInfo {
  return { ...parts };
}
