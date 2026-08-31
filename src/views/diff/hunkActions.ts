/**
 * Which per-hunk buttons a file entry may offer, and why it sometimes offers
 * none.
 *
 * Pure and separate from the component because the answer is a safety
 * decision, not a layout one. `serializeHunks` refuses to build a patch for
 * binary, conflicted, renamed and copied entries — offering a button that can
 * only throw would teach the user the feature is broken, and offering one that
 * *worked* on a rename would un-rename the file in the index while leaving the
 * other hunks applied to the old path.
 */

import { discardHunkRefusal } from '../../git/stage';
import type { FileDiff } from '../../git/types';

export type HunkAction = 'stage' | 'unstage' | 'discard';

export interface HunkActionSpec {
  action: HunkAction;
  label: string;
  /** True for the one that removes work; the UI gives it a warning colour. */
  danger: boolean;
}

const STAGE: HunkActionSpec = { action: 'stage', label: 'Stage Hunk', danger: false };
const UNSTAGE: HunkActionSpec = {
  action: 'unstage',
  label: 'Unstage Hunk',
  danger: false,
};
const DISCARD: HunkActionSpec = {
  action: 'discard',
  label: 'Discard Hunk',
  danger: true,
};

/**
 * Why this file's hunks cannot be acted on one at a time, or `null` when they
 * can. A commit's diff is not "blocked" — it is history, with nothing to move —
 * so it is handled by {@link hunkActions} returning nothing at all.
 */
export function hunkActionBlocker(file: FileDiff): string | null {
  if (file.binary) {
    return 'A binary file has no hunks to pick from — stage or discard the whole file.';
  }
  if (file.conflicted) {
    return 'Resolve this conflict first; an unmerged path has no patch to apply.';
  }
  if (file.kind === 'renamed' || file.kind === 'copied') {
    // Git infers the rename from the two paths in the patch header, so a patch
    // carrying only some hunks would record the content without the rename.
    return `Hunk-level staging is not available for a ${file.kind} file; stage it whole.`;
  }
  if (file.newMode === '120000' || file.oldMode === '120000') {
    // A symlink's patch body is its target string, and writing that text back
    // to the path follows the link — clobbering a file outside the repository
    // that the user never selected.
    return 'A symlink has no hunks to pick from; stage or discard the whole file.';
  }
  return null;
}

/**
 * The buttons for one file entry.
 *
 * The side is what decides the direction, and it is the reason the diff loader
 * stamps it: an unstaged hunk is staged, a staged one is unstaged, and the two
 * can be on screen for the same path at the same time.
 *
 * Discard is offered only on the unstaged side. A staged hunk's content still
 * exists in the index, so "discard" there would mean two different things —
 * drop it from the index, or from both — and the honest answer is to make the
 * user unstage first and see what is left.
 */
export function hunkActions(file: FileDiff): HunkActionSpec[] {
  if (file.side === 'commit') return [];
  if (hunkActionBlocker(file) !== null) return [];
  if (file.side === 'staged') return [UNSTAGE];
  // Discard has refusals of its own — an added file would be *deleted* by a
  // reverse apply, which is not what the confirmation describes. Staging the
  // same hunk stays available.
  return discardHunkRefusal(file) === null ? [DISCARD, STAGE] : [STAGE];
}

/** Sentence the user has to agree to before a hunk is discarded. */
export function discardHunkQuestion(path: string, header: string): string {
  return (
    `Discard this hunk of ${path}? The lines it changes go back to their staged ` +
    `state on disk. Krakenless saves the file's current bytes first, so you can ` +
    `undo this from Recent discards. Hunk: ${header}`
  );
}
