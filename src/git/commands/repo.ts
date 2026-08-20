import type { GitCommand } from '../types';

/**
 * Git-dir and bare-ness. Kept separate from `--show-toplevel` because that
 * flag makes the whole invocation fail with exit 128 in a bare repository
 * (verified against git 2.39) — asking for both would make bare repos
 * unreachable.
 *
 * Output: exactly two lines, in flag order.
 */
export function buildRepoProbeCommand(): GitCommand {
  return {
    args: [
      'rev-parse',
      '--path-format=absolute',
      '--absolute-git-dir',
      '--is-bare-repository',
    ],
  };
}

/** Working-tree root. Only valid for non-bare repositories. One output line. */
export function buildToplevelCommand(): GitCommand {
  return { args: ['rev-parse', '--path-format=absolute', '--show-toplevel'] };
}

/** Resolves HEAD; exits 1 with no output in a repository with no commits. */
export function buildHeadOidCommand(): GitCommand {
  return { args: ['rev-parse', '--verify', '--quiet', 'HEAD'] };
}
