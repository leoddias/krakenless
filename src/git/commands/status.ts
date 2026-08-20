import { pathspec } from '../argsafety';
import { GitError } from '../errors';
import type { GitCommand } from '../types';

const UNTRACKED_MODES = ['all', 'normal', 'no'] as const;

export interface StatusOptions {
  /**
   * `all` lists every file inside an untracked directory; `normal` collapses
   * the directory into a single `dir/` entry. The GUI stages individual files,
   * so `all` is the default — with `normal` the user would be offered a path
   * that is not a file.
   */
  untracked?: 'all' | 'normal' | 'no';
  /** Adds `!` records for ignored paths. Off by default: the list is huge. */
  includeIgnored?: boolean;
  /** Limit the report to these repository-relative paths. */
  paths?: string[];
}

/**
 * Status of the whole worktree, machine-readable.
 *
 * Uses porcelain **v2** (v1 cannot express submodule state or rename scores)
 * with `-z`: with `-z` git never quotes or escapes a path, so a filename with
 * a newline, a quote, or a backslash arrives verbatim. `--branch` adds the
 * `# branch.*` headers the UI needs for ahead/behind.
 *
 * `--no-pager` and `-c core.quotePath=false` are prepended by the runner for
 * every invocation, so they are deliberately absent here.
 *
 * Two git-level options come first, before the subcommand:
 *
 * - `--no-optional-locks`: `status` otherwise refreshes and rewrites the index
 *   under `.git/index.lock`. Status is the command the app runs most often, so
 *   it is the most likely to hit the runner timeout — and the runner kills the
 *   process group with SIGKILL, which runs no cleanup and would leave the lock
 *   behind, breaking every later `add`/`commit` in that repository.
 * - `--literal-pathspecs` is prepended by the Rust runner for every command
 *   (ADR-0015), so pathspec magic such as `:(glob)` is never interpreted here.
 */
export function buildStatusCommand(options: StatusOptions = {}): GitCommand {
  const untracked = options.untracked ?? 'all';
  if (!UNTRACKED_MODES.includes(untracked)) {
    // The union type is erased at runtime; options can arrive from persisted
    // settings, and an unchecked value would be interpolated into an argument.
    throw new GitError('bad-argument', `unknown untracked mode: ${String(untracked)}`);
  }
  const args = [
    '--no-optional-locks',
    'status',
    '--porcelain=v2',
    '--branch',
    // Forces the `# branch.ab` record even when the user's config sets
    // `status.aheadBehind=false`; without it the counts silently go missing
    // and an unknown relationship would read as "up to date".
    '--ahead-behind',
    '-z',
    `--untracked-files=${untracked}`,
  ];
  if (options.includeIgnored) {
    if (untracked === 'no') {
      // git 2.39 exits 128 with "Unsupported combination of ignored and
      // untracked-files arguments". Caught here so the caller gets a typed
      // bad-argument instead of a generic command failure.
      throw new GitError(
        'bad-argument',
        'ignored files cannot be listed with --untracked-files=no',
      );
    }
    // `matching` lists ignored files individually. The default (`traditional`)
    // collapses an ignored directory into one entry unless untracked=all, so
    // its output would silently change with the untracked mode.
    args.push('--ignored=matching');
  }
  if (options.paths !== undefined) {
    // Routed through pathspec(): a user-selected path that is absolute or
    // escapes the repository would make status report a tree we never opened.
    args.push(...pathspec(options.paths));
  }
  return { args };
}
