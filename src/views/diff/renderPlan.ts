/**
 * Decides how much of a diff is actually rendered.
 *
 * The diff panel used to mount every line of every file as DOM. A commit that
 * touches a lockfile or a vendored tree produces hundreds of thousands of
 * lines, and mounting them froze the window — the git call was long done; the
 * browser was the bottleneck. The plan computed here bounds the initial DOM to
 * a budget and puts everything beyond it behind an explicit control that says
 * exactly how many lines it is holding back.
 *
 * Pure functions, so the thresholds and the arithmetic are unit-testable
 * without rendering anything.
 */

import type { FileDiff, Hunk } from '../../git/types';

/**
 * A file whose diff is larger than this starts collapsed. Roughly what fits
 * in a few screens — big enough that ordinary files are never hidden, small
 * enough that a generated file does not take the panel down with it.
 */
export const FILE_LINE_BUDGET = 400;

/**
 * Total lines the panel renders by default across all files. Once the sum of
 * auto-expanded files passes this, the rest start collapsed even when small:
 * five hundred ten-line files are the same DOM as one five-thousand-line file.
 */
export const PANEL_LINE_BUDGET = 2_000;

/** How many more lines one click on "Show more" reveals. */
export const REVEAL_CHUNK = 1_000;

/** What the panel renders for one file. */
export interface FilePlan {
  file: FileDiff;
  /** Identity for reveal state: side + path, the same pair the list keys by. */
  key: string;
  /** Total diff lines across the file's hunks. */
  total: number;
  added: number;
  deleted: number;
  /** Lines to render now. `0` means collapsed behind the control. */
  visible: number;
}

export function planKey(file: FileDiff): string {
  return `${file.side}:${file.newPath}`;
}

/**
 * Plans every file in one pass, counting each line exactly once.
 *
 * `revealed` holds the user's explicit choices — lines they asked to see per
 * file key. A revealed file is always honored in full, budget or not: the
 * budget exists to protect the user from an accidental mountain, not to
 * overrule a deliberate click.
 */
export function planFiles(
  files: readonly FileDiff[],
  revealed: ReadonlyMap<string, number>,
): FilePlan[] {
  let remaining = PANEL_LINE_BUDGET;

  return files.map((file) => {
    let total = 0;
    let added = 0;
    let deleted = 0;
    for (const hunk of file.hunks) {
      total += hunk.lines.length;
      for (const line of hunk.lines) {
        if (line.kind === 'added') added += 1;
        else if (line.kind === 'deleted') deleted += 1;
      }
    }

    const key = planKey(file);
    const asked = revealed.get(key);
    let visible: number;
    if (asked !== undefined) {
      visible = Math.min(total, asked);
    } else if (total <= FILE_LINE_BUDGET && total <= remaining) {
      visible = total;
    } else {
      visible = 0;
    }
    remaining -= visible;

    return { file, key, total, added, deleted, visible };
  });
}

/** One hunk as rendered: the original object, and the lines shown from it. */
export interface HunkSlice {
  /**
   * The hunk exactly as parsed. Anything that acts on the hunk — staging,
   * discarding — must use this object, never a trimmed copy: a partial hunk
   * fed back to `git apply` is a different patch than the one on screen.
   */
  hunk: Hunk;
  /** The prefix of its lines that is rendered. */
  lines: Hunk['lines'];
  /** Lines of this hunk not rendered (the tail beyond the visible count). */
  hidden: number;
}

/**
 * Cuts a file's hunks down to `visible` lines, keeping whole hunks where
 * possible and truncating only the last one shown.
 */
export function sliceHunks(file: FileDiff, visible: number): HunkSlice[] {
  const slices: HunkSlice[] = [];
  let remaining = visible;
  for (const hunk of file.hunks) {
    if (remaining <= 0) break;
    const shown = Math.min(hunk.lines.length, remaining);
    slices.push({
      hunk,
      lines: shown === hunk.lines.length ? hunk.lines : hunk.lines.slice(0, shown),
      hidden: hunk.lines.length - shown,
    });
    remaining -= shown;
  }
  return slices;
}
