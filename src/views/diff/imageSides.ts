/**
 * Which files the diff panel previews as images, and which two versions.
 *
 * Git prints "Binary files differ" and nothing else for an image, so the panel
 * fetches the versions itself. Which versions depends on what the diff
 * compared: a commit against its first parent, the index against `HEAD`, or the
 * working tree against the index. Getting that pairing wrong would show a
 * "before" that is not what the diff was taken against — so it lives here,
 * where each pairing is a test.
 */

import type { BlobSource } from '../../git/commands/blob';
import type { FileDiff } from '../../git/types';

/** Formats a webview can draw from a data URL, by extension. */
const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

/**
 * The image MIME type for a path, or `null` when it is not previewed.
 *
 * SVG is left out on purpose: git diffs it as text, which already shows it,
 * and an SVG is a document that can carry script.
 */
export function imageMime(path: string): string | null {
  const dot = path.lastIndexOf('.');
  if (dot === -1 || dot < path.lastIndexOf('/')) return null;
  return MIME_BY_EXTENSION[path.slice(dot + 1).toLowerCase()] ?? null;
}

/** Where one version of the file is read from. */
export type ImageSource =
  { from: 'blob'; source: BlobSource; path: string } | { from: 'worktree'; path: string };

export interface ImageSides {
  /** The version the diff compares against; `null` when the file is new. */
  before: ImageSource | null;
  /** The version the diff arrives at; `null` when the file is gone. */
  after: ImageSource | null;
}

/**
 * The two versions to draw for a binary image diff, or `null` when the file is
 * not one the panel previews.
 *
 * `commitOid` is the selected commit; a commit-side diff without one cannot be
 * paired with anything and is not previewed.
 */
export function imageSides(file: FileDiff, commitOid: string | null): ImageSides | null {
  if (!file.binary || file.conflicted) return null;
  // Either name counts: a rename from `.png` to `.bin` is still an image before.
  if (imageMime(file.newPath) === null && imageMime(file.oldPath) === null) return null;

  const isNew = file.kind === 'added';
  const isGone = file.kind === 'deleted';
  const old = file.oldPath;
  const now = file.newPath;

  switch (file.side) {
    case 'commit':
      if (commitOid === null) return null;
      return {
        before: isNew
          ? null
          : {
              from: 'blob',
              source: { kind: 'commit', oid: commitOid, parent: true },
              path: old,
            },
        after: isGone
          ? null
          : { from: 'blob', source: { kind: 'commit', oid: commitOid }, path: now },
      };
    case 'staged':
      return {
        before: isNew ? null : { from: 'blob', source: { kind: 'head' }, path: old },
        after: isGone ? null : { from: 'blob', source: { kind: 'index' }, path: now },
      };
    case 'unstaged':
      return {
        before: isNew ? null : { from: 'blob', source: { kind: 'index' }, path: old },
        after: isGone ? null : { from: 'worktree', path: now },
      };
  }
}

/** A byte count as people read it: `512 B`, `12.4 KB`, `3.1 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Below this many pixels on its longer side, an image is drawn enlarged. */
const SMALL_IMAGE = 96;
const MAX_SCALE = 8;

/**
 * The whole-number factor a small image is drawn at.
 *
 * A 16×16 icon at its own size is a speck nobody can judge a change in; drawn
 * at a whole multiple with nearest-neighbour scaling it shows every pixel the
 * commit touched, which is what a preview of a sprite is for. Whole numbers
 * only, so no pixel is drawn wider than its neighbour.
 */
export function displayScale(width: number, height: number): number {
  const longest = Math.max(width, height);
  if (longest <= 0 || longest >= SMALL_IMAGE) return 1;
  return Math.min(MAX_SCALE, Math.floor(SMALL_IMAGE / longest));
}
