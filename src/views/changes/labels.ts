/**
 * Wording and grouping for the changes panel.
 *
 * Kept pure and separate from the component so every rule that decides *which
 * list a path lands in* can be asserted directly. That split matters here more
 * than elsewhere: putting a conflicted path in the ordinary "unstaged" list
 * would offer to stage a file full of conflict markers, which silently records
 * a wrong resolution.
 */

import type { FileState, StatusEntry } from '../../git/types';

export interface ChangeGroups {
  /** Paths with something in the index, ready to be committed. */
  staged: StatusEntry[];
  /** Paths changed in the working tree only, including untracked ones. */
  unstaged: StatusEntry[];
  /** Unmerged paths. Never in the other two lists — see `groupEntries`. */
  conflicted: StatusEntry[];
}

/**
 * Splits status entries into the three lists the panel shows.
 *
 * A path can be in both `staged` and `unstaged` (staged edit plus a newer
 * unstaged one) — that is git's truth and hiding either half would lie about
 * what a commit will contain. Conflicted paths are pulled out entirely, and
 * ignored paths are dropped: they are not changes the user asked to see, and
 * offering "stage" for them invites committing build output.
 */
export function groupEntries(entries: readonly StatusEntry[]): ChangeGroups {
  const groups: ChangeGroups = { staged: [], unstaged: [], conflicted: [] };

  for (const entry of entries) {
    if (entry.conflicted) {
      groups.conflicted.push(entry);
      continue;
    }
    if (entry.index !== 'unmodified') groups.staged.push(entry);
    if (entry.worktree !== 'unmodified' && entry.worktree !== 'ignored') {
      groups.unstaged.push(entry);
    }
  }

  return groups;
}

/** Renames and copies read as `old → new`; anything else is just the path. */
export function displayPath(entry: StatusEntry): string {
  const source = sourcePath(entry);
  return source === null ? entry.path : `${source} → ${entry.path}`;
}

function sourcePath(entry: StatusEntry): string | null {
  if (entry.origPath === undefined || entry.origPath === entry.path) return null;
  return entry.origPath;
}

/**
 * Every path an action on this entry has to name.
 *
 * A rename is two paths in git's eyes: the removal of the old one and the
 * addition of the new one. Acting on `path` alone leaves the other half behind
 * — unstaging a rename would keep `old.ts` staged as a deletion, and
 * discarding one would leave the worktree with neither file.
 *
 * A *copy* is the opposite case: its source is untouched, so naming it would
 * stage or discard edits the user never pointed at.
 */
export function pathsOf(entry: StatusEntry): string[] {
  const source = sourcePath(entry);
  const renamed = entry.index === 'renamed' || entry.worktree === 'renamed';
  return source !== null && renamed ? [source, entry.path] : [entry.path];
}

/** Paths for a whole list, in order and without repeats. */
export function pathsOfAll(entries: readonly StatusEntry[]): string[] {
  return [...new Set(entries.flatMap(pathsOf))];
}

/** Single-letter status marker, matching what `git status` prints. */
export const STATE_LETTERS: Record<FileState, string> = {
  unmodified: '.',
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  'type-changed': 'T',
  untracked: '?',
  ignored: '!',
  unmerged: 'U',
};

/** Spelled-out state, so the row never depends on knowing git's letters. */
export const STATE_LABELS: Record<FileState, string> = {
  unmodified: 'Unmodified',
  modified: 'Modified',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  'type-changed': 'Type changed',
  untracked: 'Untracked',
  ignored: 'Ignored',
  unmerged: 'Conflicted',
};

/** Explains a conflict well enough that the user knows what to resolve. */
export function conflictDescription(kind: StatusEntry['conflictKind']): string {
  switch (kind) {
    case 'DD':
      return 'Both sides deleted this file.';
    case 'AU':
      return 'Added by us, changed by them.';
    case 'UD':
      return 'Changed by us, deleted by them.';
    case 'UA':
      return 'Changed by us, added by them.';
    case 'DU':
      return 'Deleted by us, changed by them.';
    case 'AA':
      return 'Both sides added this file.';
    case 'UU':
      return 'Both sides changed this file.';
    default:
      return 'This path is unmerged.';
  }
}

/** Question the confirmation step asks; it always names the count. */
export function discardQuestion(paths: readonly string[]): string {
  const count = paths.length;
  return count === 1
    ? 'Discard changes to 1 file?'
    : `Discard changes to ${count} files?`;
}

/**
 * Wording for the recovery notice.
 *
 * The exact command comes from the git layer (`DiscardResult.undoCommands`) and
 * is rendered next to this text, because only that layer knows the stash oid.
 * It is deliberately `git restore --source=<oid> --worktree`: `git stash pop`
 * would conflict, and `git checkout <oid> -- <path>` would overwrite the staged
 * version that the discard kept intact.
 */
export function recoveryMessage(): string {
  return 'Krakenless stashed your unstaged changes before discarding them. Run this to bring them back — your staged version was left untouched:';
}
