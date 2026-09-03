/**
 * The model behind the working-tree file context menu.
 *
 * Built as data rather than JSX, for the reason the commit menu gives: half
 * these items must not run in some states — a path with nothing unstaged
 * cannot be discarded, a file git has already seen deleted cannot be deleted
 * again, a conflicted path must not be touched by either — and deriving that
 * here makes each refusal a test instead of a rendering detail.
 *
 * Nothing is hidden for being unavailable. A missing item reads as a feature
 * the app does not have; a greyed one carrying its reason reads as "not right
 * now, and here is why".
 */

import type { StatusEntry } from '../../git/types';
import { pathsOf } from './labels';

/** What a menu item does when it is chosen. */
export type FileAction =
  | { kind: 'discard'; paths: string[] }
  | { kind: 'delete'; paths: string[] }
  | { kind: 'reveal'; path: string }
  | { kind: 'copy'; text: string; what: string };

export interface FileMenuItem {
  id: string;
  label: string;
  /** Why this cannot run right now, or `null` when it can. */
  disabled: string | null;
  action?: FileAction;
}

/** Items are grouped; the renderer draws a rule between groups. */
export type FileMenuSection = FileMenuItem[];

/** Everything the menu needs to decide what it may offer. */
export interface FileMenuContext {
  /** Rows the menu acts on: the right-clicked row, or the whole selection. */
  entries: StatusEntry[];
  /** Absolute path of the working-tree root, or `null` when unknown. */
  root: string | null;
  busy: boolean;
  /** Paths that currently have unstaged changes — the only discardable ones. */
  discardable: ReadonlySet<string>;
}

const BUSY = 'Another git operation is already running.';

/**
 * The path an entry names *on disk*.
 *
 * A rename has two paths in git's eyes and a discard has to name both (see
 * `pathsOf`), but only one of them exists in the file system: the new one. That
 * is the one a file manager, a delete and a copied path are about.
 */
export function livePath(entry: StatusEntry): string {
  return entry.path;
}

/**
 * Joins a repository-relative path onto the working-tree root.
 *
 * Separators follow the root: git reports `C:/repos/app` with forward slashes
 * on Windows, and a path built that way is fine for every consumer here — Rust
 * converts it for Explorer, and a copied path pastes into git, PowerShell and
 * the address bar alike. What must not happen is *mixing*: a root that already
 * uses backslashes keeps them, so the result is not `C:\repos\app/src/a.ts`.
 */
export function absolutePath(root: string, path: string): string {
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const trimmed = root.replace(/[/\\]+$/, '');
  const relative = separator === '\\' ? path.replace(/\//g, '\\') : path;
  return `${trimmed}${separator}${relative}`;
}

/** True when git says the file is no longer on disk. */
function goneFromDisk(entry: StatusEntry): boolean {
  return entry.worktree === 'deleted';
}

/**
 * The question a delete has to ask, in the words the user reads.
 *
 * The count is in the title because a right-click on a row that happened to be
 * inside a selection acts on the whole selection, and "Delete 12 files" is the
 * only warning that a click on one row is about to touch twelve.
 */
export function deleteQuestion(paths: string[]): string {
  return paths.length === 1
    ? `Delete ${paths[0] ?? ''} from disk?`
    : `Delete ${String(paths.length)} files from disk?`;
}

/** What a delete costs, per path, said before it happens. */
export interface DeleteCost {
  /** Paths whose contents exist nowhere but this disk. */
  untracked: string[];
  /** Paths git has a committed version of, edits aside. */
  tracked: string[];
}

/**
 * Splits the paths by what git could give back afterwards.
 *
 * Untracked files are the reason this dialog is worded the way it is: git has
 * never seen them, so nothing in the repository can restore one. A tracked
 * file's last committed state survives, but any uncommitted edit goes with it.
 */
export function deleteCost(entries: StatusEntry[]): DeleteCost {
  const cost: DeleteCost = { untracked: [], tracked: [] };
  for (const entry of entries) {
    if (entry.worktree === 'untracked') cost.untracked.push(entry.path);
    else cost.tracked.push(entry.path);
  }
  return cost;
}

/**
 * The menu for one or more working-tree rows.
 *
 * `entries` is what the user actually pointed at: a right-click inside a
 * multi-file selection acts on all of it, a right-click anywhere else acts on
 * that row alone. The caller decides which; this only reports what may be done
 * with what it was handed.
 */
export function buildFileMenu(context: FileMenuContext): FileMenuSection[] {
  const { entries, root, busy, discardable } = context;
  const paths = entries.map(livePath);
  const plural = paths.length > 1;

  return [
    [discardItem(entries, discardable, busy, plural), deleteItem(entries, busy, plural)],
    [revealItem(entries, root, plural), ...copyItems(paths, root)],
  ];
}

function discardItem(
  entries: StatusEntry[],
  discardable: ReadonlySet<string>,
  busy: boolean,
  plural: boolean,
): FileMenuItem {
  const label = plural
    ? `Discard changes in ${String(entries.length)} files`
    : 'Discard changes';
  const item: FileMenuItem = { id: 'discard', label, disabled: null };

  if (entries.some((entry) => entry.conflicted)) {
    return {
      ...item,
      disabled:
        'This path is unmerged. Resolve the conflict before discarding anything in it.',
    };
  }
  if (!entries.some((entry) => discardable.has(entry.path))) {
    return {
      ...item,
      disabled: plural
        ? 'None of these has unstaged changes. Discard only removes working-tree edits; unstage first to drop a staged one.'
        : 'This file has no unstaged changes. Discard only removes working-tree edits; unstage it first to drop the staged one.',
    };
  }
  if (busy) return { ...item, disabled: BUSY };
  // Only the rows that actually have something to discard: passing the others
  // would have the confirmation name files it is not going to touch.
  return {
    ...item,
    action: {
      kind: 'discard',
      paths: entries.filter((entry) => discardable.has(entry.path)).flatMap(pathsOf),
    },
  };
}

function deleteItem(
  entries: StatusEntry[],
  busy: boolean,
  plural: boolean,
): FileMenuItem {
  const item: FileMenuItem = {
    id: 'delete',
    label: plural
      ? `Delete ${String(entries.length)} files from disk`
      : 'Delete from disk',
    disabled: null,
  };

  const present = entries.filter((entry) => !goneFromDisk(entry));
  if (present.length === 0) {
    return {
      ...item,
      disabled: plural
        ? 'None of these is on disk any more; git already reports them deleted.'
        : 'This file is not on disk any more; git already reports it deleted.',
    };
  }
  if (busy) return { ...item, disabled: BUSY };
  return { ...item, action: { kind: 'delete', paths: present.map(livePath) } };
}

function revealItem(
  entries: StatusEntry[],
  root: string | null,
  plural: boolean,
): FileMenuItem {
  const item: FileMenuItem = {
    id: 'reveal',
    label: 'Reveal in file manager',
    disabled: null,
  };
  const first = entries[0];
  if (first === undefined) return { ...item, disabled: 'Nothing is selected.' };
  if (root === null) {
    return { ...item, disabled: 'The repository path is not known yet.' };
  }
  if (plural) {
    return {
      ...item,
      disabled: 'A file manager opens one file at a time. Select a single file.',
    };
  }
  if (goneFromDisk(first)) {
    return { ...item, disabled: 'This file is not on disk any more.' };
  }
  return {
    ...item,
    action: { kind: 'reveal', path: absolutePath(root, livePath(first)) },
  };
}

/**
 * Both paths, because both are asked for and they are not interchangeable.
 *
 * The relative one is what git speaks — it pastes into a `git` command, an
 * issue, a code review. The absolute one is what everything outside the
 * repository speaks. Several rows copy one path per line, which is what a shell
 * loop and a text editor both expect.
 */
function copyItems(paths: string[], root: string | null): FileMenuItem[] {
  const relative = paths.join('\n');
  const absolute =
    root === null ? null : paths.map((path) => absolutePath(root, path)).join('\n');

  return [
    {
      id: 'copy-relative',
      label: paths.length > 1 ? 'Copy paths' : 'Copy path',
      disabled: paths.length === 0 ? 'Nothing is selected.' : null,
      action: { kind: 'copy', text: relative, what: 'path' },
    },
    {
      id: 'copy-absolute',
      label: paths.length > 1 ? 'Copy full paths' : 'Copy full path',
      disabled: absolute === null ? 'The repository path is not known yet.' : null,
      ...(absolute === null
        ? {}
        : { action: { kind: 'copy', text: absolute, what: 'full path' } as FileAction }),
    },
  ];
}
