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
 * The panel now renders one file at a time (the list is the navigation, the
 * body is the file you picked), so the budget is per file. There used to be a
 * whole-panel budget on top of it, for when every file's diff was mounted at
 * once; with one body on screen it could only do harm — it was spent walking
 * files nobody was looking at, and collapsed the small file that was.
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
 *
 * Every file is planned, not just the one on screen: the list beside the body
 * shows each file's added and deleted counts, and those come from here.
 */
export function planFiles(
  files: readonly FileDiff[],
  revealed: ReadonlyMap<string, number>,
): FilePlan[] {
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
    const visible =
      asked !== undefined
        ? Math.min(total, asked)
        : total <= FILE_LINE_BUDGET
          ? total
          : 0;

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
