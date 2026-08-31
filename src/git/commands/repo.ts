import type { GitCommand } from '../types';

/**
 * Git-dir and bare-ness. Kept separate from `--show-toplevel` because that
 * flag makes the whole invocation fail with exit 128 in a bare repository
 * (verified against git 2.39) — asking for both would make bare repos
 * unreachable.
 *
 * Output: exactly two lines, in flag order.
 *
 * No `--path-format=absolute` here: `rev-parse` *echoes* flags it does not
 * recognize to stdout and still exits 0, so on git < 2.31 (where the flag
 * does not exist) it became a third output line and every open failed with a
 * line-count parse error. Both outputs are absolute anyway —
 * `--absolute-git-dir` by definition, `--show-toplevel` always.
 */
export function buildRepoProbeCommand(): GitCommand {
  return {
    args: ['rev-parse', '--absolute-git-dir', '--is-bare-repository'],
  };
}

/** Working-tree root. Only valid for non-bare repositories. One output line. */
export function buildToplevelCommand(): GitCommand {
  return { args: ['rev-parse', '--show-toplevel'] };
}

/** Resolves HEAD; exits 1 with no output in a repository with no commits. */
export function buildHeadOidCommand(): GitCommand {
  return { args: ['rev-parse', '--verify', '--quiet', 'HEAD'] };
}
