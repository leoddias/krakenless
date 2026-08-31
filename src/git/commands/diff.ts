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
 * - `--submodule=short`: this one is not cosmetic. Verified against git 2.39,
 *   `diff.submodule = log` replaces a changed gitlink with a prose
 *   `Submodule <name> <a>..<b>:` block, and `diff.submodule = diff` follows it
 *   with `diff --git a/<sub>/<file>` entries whose content lives in the
 *   *submodule's* object store while the path reads as a superproject path.
 *   Handing that to `git apply --cached` in the superproject stages bytes the
 *   path does not own. `short` restores the plain `160000` gitlink hunk.
 * - `--ignore-submodules=none`: the sharper half of the same problem.
 *   `diff.ignoreSubmodules = all` makes git emit *nothing at all* for a changed
 *   gitlink, so no parser can notice it and the user commits believing the
 *   submodule is untouched (verified against git 2.39).
 * - `--inter-hunk-context=0`: `diff.interHunkContext` decides when two nearby
 *   hunks are merged into one, i.e. how coarse the user's staging choices are.
 *
 * - `--full-index`: `core.abbrev` decides how short the `index <a>..<b>` blob
 *   ids are. `git apply --3way` — the recoverable form M2 wants for staging
 *   against a moving index — has to resolve them, and an abbreviation that has
 *   become ambiguous makes the 3-way fallback fail.
 *
 * `diff.algorithm` and `diff.indentHeuristic` are deliberately *not* pinned:
 * they move where hunk boundaries fall, but every output they produce is a
 * valid, appliable patch, and a user who chose an algorithm should keep it.
 *
 * One config is not fixable from here: `diff.suppressBlankEmpty` prints an
 * empty context line with no leading space, and there is no command-line
 * override. The parser accepts that shape instead.
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
  '--submodule=short',
  '--ignore-submodules=none',
  '--inter-hunk-context=0',
  '--full-index',
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

/**
 * Same, but always ends the revision list. After a revision argument a bare
 * `--` is what stops git from having to guess whether the next word is a ref
 * or a file, and it is harmless when there is nothing after it.
 */
function terminatedPathArgs(options: DiffOptions): string[] {
  const args = pathArgs(options);
  return args.length === 0 ? ['--'] : args;
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
 * File-level summary of what is staged: one line per file, plus a total.
 *
 * The fallback when a staged patch is too large to send to an AI CLI whole.
 * `--stat` is not parsed by anything — it is prose for a model — so it
 * deliberately skips {@link DIFF_FLAGS}, which exist to keep *patches*
 * machine-stable.
 */
export function buildStagedStatCommand(options: DiffOptions = {}): GitCommand {
  return { args: ['diff', '--cached', '--stat', '--no-color', ...pathArgs(options)] };
}

/**
 * The patch a single commit introduced.
 *
 * `--format=` drops the commit header so stdout is nothing but the patch, and
 * `--no-show-signature` keeps `log.showSignature` from putting a gpg report
 * back in front of it.
 *
 * `-m --first-parent` matters most: without it `git show` of a merge emits a
 * *combined* diff (`diff --cc`, `@@@` headers), which is a different format
 * that `git apply` cannot consume.
 *
 * Not `--diff-merges=first-parent`, which says the same thing in one flag but
 * only from git 2.31. Older git knows the option and rejects the *value*
 * (`fatal: unknown value for --diff-merges: first-parent`) — and since this
 * flag is on every commit diff, that failure is not limited to merges: it
 * makes the diff panel unusable for every commit in the repository. `-m` and
 * `--first-parent` both long predate it, and produce byte-identical output for
 * merge, ordinary and root commits alike.
 */
export function buildCommitDiffCommand(
  rev: string,
  options: DiffOptions = {},
): GitCommand {
  return {
    args: [
      'show',
      '--format=',
      '--no-show-signature',
      '-m',
      '--first-parent',
      ...DIFF_FLAGS,
      assertRevision(rev),
      ...terminatedPathArgs(options),
    ],
  };
}
