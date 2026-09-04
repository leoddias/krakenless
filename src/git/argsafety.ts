/**
 * Guards for values the user can name — branches, tags, paths.
 *
 * Git happily creates a branch called `--force`. Passing such a name as a bare
 * argument turns it into an option: `git branch -D --force` or
 * `git push origin --delete --all` are one misnamed ref away. Every builder
 * that accepts a user-supplied value routes it through here.
 */

import { GitError } from './errors';

function reject(message: string, value: string): never {
  throw new GitError('bad-argument', `${message}: ${JSON.stringify(value)}`, {
    args: [value],
  });
}

/**
 * Separator plus paths. Requires at least one path: a bare `--` means "all
 * paths" to several subcommands, which would silently widen a discard from one
 * file to the whole worktree.
 */
export function pathspec(paths: string[]): string[] {
  if (paths.length === 0) {
    reject('pathspec needs at least one path', '');
  }
  return ['--', ...paths.map(assertPath)];
}

/**
 * Past this many characters of paths, the list travels on stdin.
 *
 * Windows caps a command line at 32,767 characters, and `CreateProcess`
 * fails outright above it — the runner then reports "could not start git",
 * which is not what happened. The cap is set well under the limit so the
 * subcommand, its flags and the runner's own globals always fit beside it.
 */
export const PATHSPEC_ARGV_LIMIT = 8_000;

/**
 * Splits a path list into runs that each fit the argument budget.
 *
 * For `git stash push`, which cannot take a long list at all: given a
 * pathspec file it still hands the paths to the `git clean` and `git checkout`
 * it spawns underneath *as arguments*, and on Windows that inner spawn fails
 * with "Filename too long" — after the stash entry has been written (verified
 * against git 2.39 with 5,000 paths). So the caller runs one push per run,
 * and every run is short enough for git's own subprocesses.
 */
export function chunkPathspec(paths: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const path of paths.map(assertPath)) {
    if (current.length > 0 && length + path.length + 1 > PATHSPEC_ARGV_LIMIT) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(path);
    length += path.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** What a builder spreads into its command: arguments, and maybe stdin. */
export interface PathspecInput {
  args: string[];
  stdin?: string;
}

/**
 * A pathspec sized for the command line it will run on.
 *
 * A short list goes after `--` as always. A long one — "Discard all" over a
 * few thousand untracked files is the case that found this — goes through
 * `--pathspec-from-file=- --pathspec-file-nul`, NUL-separated on stdin, which
 * has no length limit. Both forms are literal: the runner's
 * `--literal-pathspecs` sets `GIT_LITERAL_PATHSPECS`, which git honours for a
 * pathspec file just as for arguments (verified against git 2.39).
 *
 * Only for subcommands that accept `--pathspec-from-file`: `add`, `restore`,
 * `stash push`, `checkout`, `reset`, `rm`, `commit`. `diff` and `ls-files` do
 * not, and must not be given one.
 */
export function pathspecInput(paths: string[]): PathspecInput {
  if (paths.length === 0) {
    reject('pathspec needs at least one path', '');
  }
  const checked = paths.map(assertPath);
  const length = checked.reduce((sum, path) => sum + path.length + 1, 0);
  if (length <= PATHSPEC_ARGV_LIMIT) return { args: ['--', ...checked] };
  return {
    args: ['--pathspec-from-file=-', '--pathspec-file-nul'],
    stdin: checked.join('\0'),
  };
}

/**
 * A repository-relative path that is safe to pass to git. Paths always travel
 * after `--`, so a leading dash is not itself dangerous — but a path that is
 * empty, absolute, or escapes the repository points at something the user did
 * not select.
 */
export function assertPath(path: string): string {
  if (path.length === 0) reject('empty path', path);
  if (path.includes('\0')) reject('path contains NUL', path);
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/')) {
    reject('path must be repository-relative', path);
  }
  if (path === '..' || path.startsWith('../') || path.includes('/../')) {
    reject('path escapes the repository', path);
  }
  return path;
}

/**
 * A ref name safe to pass as a positional argument. This is a syntactic
 * pre-filter, not a replacement for `git check-ref-format` — it rejects the
 * shapes that would change the *meaning* of a command.
 */
export function assertRefName(name: string): string {
  if (name.length === 0) reject('empty ref name', name);
  // The one that matters: a ref starting with `-` is read as an option.
  if (name.startsWith('-')) reject('ref name may not start with a dash', name);
  // `git branch '+main'` is legal, and `git push origin +main` reads that as
  // the refspec `+main:main` — a lease-less force push.
  if (name.startsWith('+')) reject('ref name may not start with a plus', name);
  // A ref literally named `refs/heads/x` would make a refspec ambiguous.
  if (name.startsWith('refs/'))
    reject('ref name must be short, not a full ref path', name);
  if (name.includes('\0')) reject('ref name contains NUL', name);
  // Rules from git-check-ref-format(1) that are cheap to enforce here.
  if (/[\s~^:?*[\\]/.test(name)) reject('ref name contains a forbidden character', name);
  if (name.includes('..')) reject('ref name contains ".."', name);
  if (name.includes('@{')) reject('ref name contains "@{"', name);
  if (name.endsWith('.') || name.endsWith('/') || name.endsWith('.lock')) {
    reject('ref name has an invalid ending', name);
  }
  if (name.startsWith('/') || name.includes('//'))
    reject('ref name has an empty component', name);
  if (name === '@') reject('ref name may not be "@"', name);
  return name;
}

/**
 * A commit-ish the user did not type but the app derived (an oid from a parsed
 * log, `HEAD`, `HEAD~1`). Looser than {@link assertRefName} — revision syntax
 * is allowed — but a leading dash never is.
 */
export function assertRevision(rev: string): string {
  if (rev.length === 0) reject('empty revision', rev);
  if (rev.startsWith('-')) reject('revision may not start with a dash', rev);
  if (rev.includes('\0')) reject('revision contains NUL', rev);
  if (/\s/.test(rev)) reject('revision contains whitespace', rev);
  return rev;
}
