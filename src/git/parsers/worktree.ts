/**
 * Parsing `git worktree list --porcelain`.
 *
 * The format is records separated by a blank line, one fact per line:
 *
 * ```
 * worktree C:/repos/app
 * HEAD 1a2b3c…
 * branch refs/heads/main
 *
 * worktree C:/repos/app-wiki
 * HEAD 4d5e6f…
 * detached
 * locked being edited
 * prunable gitdir file points to non-existent location
 * ```
 *
 * Two things are worth stating because getting them wrong is silent. The first
 * record is always the main worktree — git emits it first, and that is the only
 * thing that distinguishes it. And a path is taken verbatim to the end of the
 * line: worktrees live wherever the user put them, spaces included, and a path
 * split on whitespace points at a directory that does not exist.
 */

import { GitError } from '../errors';
import type { Worktree } from '../types';

function fail(message: string): never {
  throw new GitError('parse-failed', message);
}

/** Splits `key value` into its two halves, value possibly empty. */
function split(line: string): { key: string; value: string } {
  const space = line.indexOf(' ');
  if (space === -1) return { key: line, value: '' };
  return { key: line.slice(0, space), value: line.slice(space + 1) };
}

/** Parses porcelain worktree records; the main worktree comes back first. */
export function parseWorktrees(stdout: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let current: Worktree | null = null;

  const flush = (): void => {
    if (current !== null) worktrees.push(current);
    current = null;
  };

  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.length === 0) {
      flush();
      continue;
    }

    const { key, value } = split(line);
    if (key === 'worktree') {
      flush();
      if (value.length === 0) fail('git listed a worktree with no path');
      current = {
        path: value,
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: null,
        prunable: null,
        // The first record git emits is the repository's own worktree; every
        // other one was added with `git worktree add`.
        main: worktrees.length === 0,
      };
      continue;
    }

    if (current === null) {
      // A fact before any `worktree` line means the output is not what this
      // parser was written against. Guessing which worktree it belongs to
      // would attach a lock or a branch to the wrong directory.
      fail(`git described a worktree before naming it: "${line}"`);
    }

    switch (key) {
      case 'HEAD':
        current.head = value.length === 0 ? null : value;
        break;
      case 'branch':
        // `refs/heads/feature/x` — only the leading namespace is dropped, so a
        // branch called `heads/x` survives being named that.
        current.branch = value.replace(/^refs\/heads\//, '');
        break;
      case 'detached':
        current.detached = true;
        break;
      case 'bare':
        current.bare = true;
        break;
      case 'locked':
        // The reason is optional; the lock is the fact that matters.
        current.locked = value;
        break;
      case 'prunable':
        current.prunable = value;
        break;
      default:
        // An unknown key is a newer git telling us something we do not use.
        // Ignoring it is right; failing would break the list on an upgrade.
        break;
    }
  }

  flush();
  return worktrees;
}
