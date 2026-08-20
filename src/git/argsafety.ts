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
