import { assertRevision, pathspec } from '../argsafety';
import type { GitCommand } from '../types';

/**
 * Flags shared by every diff-producing invocation.
 *
 * Each entry neutralises a user config that would otherwise change the *shape*
 * of the patch we parse — and, since M2 feeds these hunks back to
 * `git apply --cached`, a reshaped patch is a wrong stage, not a cosmetic bug.
 *
 * - `--no-color`: `color.diff = always` would wrap every line in escapes.
 * - `--no-ext-diff` / `--no-textconv`: `diff.external` and a `diff=<driver>`
 *   attribute make git print the output of an arbitrary program. That text is
 *   not a patch and can never be applied back.
 * - `--src-prefix` / `--dst-prefix`: `diff.noprefix`, `diff.mnemonicPrefix` and
 *   `diff.srcPrefix` all move the `a/`…`b/` prefixes the parser strips.
 * - `--no-relative`: `diff.relative` would report paths relative to the
 *   working directory instead of the repository root.
 * - `-U3`: `diff.context` would otherwise decide the context size.
 *
 * The runner already prepends `--no-pager -c core.quotePath=false`; those are
 * deliberately not repeated here.
 */
const DIFF_FLAGS = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-relative',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '-U3',
  '--find-renames',
  '--find-copies',
] as const;

export interface DiffOptions {
  /** Limit the diff to these repository-relative paths. */
  paths?: string[];
}

/** Paths, guarded and placed after `--`; nothing when the caller gave none. */
function pathArgs(options: DiffOptions): string[] {
  const paths = options.paths ?? [];
  return paths.length === 0 ? [] : pathspec(paths);
}

/** Unstaged changes: working tree against the index. */
export function buildWorktreeDiffCommand(options: DiffOptions = {}): GitCommand {
  return { args: ['diff', ...DIFF_FLAGS, ...pathArgs(options)] };
}

/** Staged changes: index against HEAD. */
export function buildStagedDiffCommand(options: DiffOptions = {}): GitCommand {
  return { args: ['diff', '--cached', ...DIFF_FLAGS, ...pathArgs(options)] };
}

/**
 * The patch a single commit introduced.
 *
 * `--format=` drops the commit header so stdout is nothing but the patch.
 * `--diff-merges=first-parent` matters: without it `git show` of a merge emits
 * a *combined* diff (`diff --cc`, `@@@` headers), which is a different format
 * that `git apply` cannot consume — the parser rejects it outright.
 */
export function buildCommitDiffCommand(
  rev: string,
  options: DiffOptions = {},
): GitCommand {
  return {
    args: [
      'show',
      '--format=',
      '--diff-merges=first-parent',
      ...DIFF_FLAGS,
      assertRevision(rev),
      ...pathArgs(options),
    ],
  };
}
