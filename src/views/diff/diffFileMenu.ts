/**
 * The model behind the diff panel's file-list context menu.
 *
 * The diff list shows commits as well as the working tree, so unlike the
 * Changes menu nothing here writes: every item either reads the path or hands
 * the file to something outside the app. Built as data for the same reason the
 * other menus are — each greyed item and its reason is a test, not a rendering
 * detail — and unavailable items stay on the menu with that reason.
 */

import type { FileDiff } from '../../git/types';
import { absolutePath } from '../changes/fileMenu';

/** What a menu item does when it is chosen. */
export type DiffFileAction =
  | { kind: 'reveal'; path: string }
  | { kind: 'edit'; path: string }
  | { kind: 'copy'; text: string; what: string };

export interface DiffFileMenuItem {
  id: string;
  label: string;
  /** Why this cannot run right now, or `null` when it can. */
  disabled: string | null;
  action?: DiffFileAction;
}

/** Items are grouped; the renderer draws a rule between groups. */
export type DiffFileMenuSection = DiffFileMenuItem[];

export interface DiffFileMenuContext {
  file: FileDiff;
  /** Absolute working-tree root, or `null` when unknown or the repo is bare. */
  root: string | null;
}

/** The last segment of a repository path — what a file manager calls it. */
export function fileName(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * Why a file cannot be handed to the file manager or the editor, or `null`.
 *
 * The path that matters is always the new one: for a rename that is where the
 * file lives now. A commit's row names the file as it was *then*; what opens
 * is whatever is on disk today, which is the only version there is to open —
 * and a file removed since is reported by the opener, not guessed at here.
 */
function diskBlocker(file: FileDiff, root: string | null): string | null {
  if (root === null) return 'This repository has no working tree to open files from.';
  if (file.kind === 'deleted') {
    return file.side === 'commit'
      ? 'This commit deletes the file, so there is nothing at that path to open.'
      : 'This file is deleted, so there is nothing on disk to open.';
  }
  return null;
}

export function buildDiffFileMenu({
  file,
  root,
}: DiffFileMenuContext): DiffFileMenuSection[] {
  const path = file.newPath;
  const blocker = diskBlocker(file, root);
  const full = root === null ? null : absolutePath(root, path);

  const onDisk = (id: string, label: string, action: DiffFileAction): DiffFileMenuItem =>
    blocker === null
      ? { id, label, disabled: null, action }
      : { id, label, disabled: blocker };

  return [
    [
      onDisk('reveal', 'Reveal in file manager', { kind: 'reveal', path: full ?? '' }),
      // `openInEditor` launches the editor in the repository root, so the
      // relative path resolves there.
      onDisk('edit', 'Open in editor', { kind: 'edit', path }),
    ],
    [
      {
        id: 'copy-relative',
        label: 'Copy path',
        disabled: null,
        action: { kind: 'copy', text: path, what: 'path' },
      },
      full === null
        ? {
            id: 'copy-absolute',
            label: 'Copy full path',
            disabled: 'This repository has no working tree, so there is no full path.',
          }
        : {
            id: 'copy-absolute',
            label: 'Copy full path',
            disabled: null,
            action: { kind: 'copy', text: full, what: 'full path' },
          },
      {
        id: 'copy-name',
        label: 'Copy file name',
        disabled: null,
        action: { kind: 'copy', text: fileName(path), what: 'file name' },
      },
    ],
  ];
}
