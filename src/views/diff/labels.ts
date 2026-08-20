/**
 * Pure labelling helpers for the diff panel.
 *
 * They live apart from the component so the wording of every "this file has no
 * hunks" case can be unit tested directly — a wrong sentence here is what makes
 * a user act on a change they did not actually see.
 */

import type { DiffLine, FileDiff } from '../../git/types';

export const CHANGE_KIND_LABELS: Record<FileDiff['kind'], string> = {
  modified: 'Modified',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  'type-changed': 'Type changed',
};

/** Marker column: the diff stays readable without relying on color alone. */
export const LINE_MARKERS: Record<DiffLine['kind'], string> = {
  context: ' ',
  added: '+',
  deleted: '-',
  'no-newline': '\\',
};

/** Screen-reader prefix so a line's kind is not conveyed by color alone. */
export const LINE_KIND_LABELS: Record<DiffLine['kind'], string> = {
  context: 'context',
  added: 'added',
  deleted: 'deleted',
  'no-newline': 'no newline marker',
};

/** `oldPath → newPath` for renames and copies, plain path otherwise. */
export function displayPath(file: FileDiff): string {
  if (file.kind === 'renamed' || file.kind === 'copied') {
    return `${file.oldPath} → ${file.newPath}`;
  }
  return file.newPath;
}

/** Added/deleted line totals; `no-newline` markers are not content lines. */
export function countLines(file: FileDiff): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'added') added += 1;
      else if (line.kind === 'deleted') deleted += 1;
    }
  }
  return { added, deleted };
}

/**
 * Why a file has no hunks to render, or `null` when it does have some.
 * Every branch returns a sentence: "no hunks" is never rendered as emptiness.
 */
export function emptyBodyReason(file: FileDiff): string | null {
  if (file.binary) {
    return 'Binary file — content is not shown as text.';
  }
  if (file.conflicted) {
    return 'Conflicted file — git reports no appliable patch until the conflict is resolved.';
  }
  if (file.hunks.length > 0) return null;

  if (hasModeChange(file)) {
    return `File mode changed only — contents are unchanged.${modeDetail(file)}`;
  }
  switch (file.kind) {
    case 'renamed':
      return 'Renamed only — contents are unchanged.';
    case 'copied':
      return 'Copied only — contents are unchanged.';
    case 'added':
      return 'New empty file — it has no contents.';
    case 'deleted':
      return 'Deleted empty file — it had no contents.';
    case 'type-changed':
      return 'File type changed — contents are not shown as text.';
    case 'modified':
      return 'No textual changes reported for this file.';
  }
}

function hasModeChange(file: FileDiff): boolean {
  return file.headerLines.some(
    (line) => line.startsWith('new mode ') || line.startsWith('old mode '),
  );
}

function modeDetail(file: FileDiff): string {
  const oldMode = modeOf(file, 'old mode ');
  const newMode = modeOf(file, 'new mode ');
  if (oldMode === null || newMode === null) return '';
  return ` ${oldMode} → ${newMode}.`;
}

function modeOf(file: FileDiff, prefix: string): string | null {
  const line = file.headerLines.find((entry) => entry.startsWith(prefix));
  return line === undefined ? null : line.slice(prefix.length).trim();
}
