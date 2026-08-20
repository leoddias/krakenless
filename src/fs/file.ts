/**
 * Reading and writing a file in the open repository's working tree.
 *
 * The Rust side (`src-tauri/src/worktree.rs`) decides *where* bytes may be
 * written and refuses anything that could escape the repository; this module
 * decides what the bytes mean. A file is only handed to the editor if its text
 * can survive a round trip through a text box unchanged (see `text.ts`), and a
 * save carries the stamp of the bytes it expects to replace, so a file that
 * changed on disk underneath the editor is never overwritten silently.
 */

import { invoke } from '@tauri-apps/api/core';
import { readShape, refusalFor, toEditor, type TextShape } from './text';

export type FileErrorKind =
  | 'bad-request'
  | 'outside-repo'
  | 'not-found'
  | 'too-large'
  | 'changed-on-disk'
  | 'read-failed'
  | 'write-failed'
  /** The bytes are fine, but a text box cannot hold them without loss. */
  | 'not-editable';

export class FileError extends Error {
  readonly kind: FileErrorKind;

  constructor(kind: FileErrorKind, message: string) {
    super(message);
    this.name = 'FileError';
    this.kind = kind;
  }
}

/** A file open in the editor, and what is needed to write it back. */
export interface OpenFile {
  path: string;
  /** LF endings, no byte-order mark: what the text box shows. */
  text: string;
  /** The shape to restore on save. */
  shape: TextShape;
  /** Identifies the bytes on disk that this was read from. */
  stamp: string;
}

/** Shape the Rust command returns. */
interface RawContents {
  text: string;
  stamp: string;
  lossy: boolean;
}

interface RawError {
  kind:
    | 'BadRequest'
    | 'OutsideRepo'
    | 'NotFound'
    | 'TooLarge'
    | 'ChangedOnDisk'
    | 'ReadFailed'
    | 'WriteFailed';
  message: string;
}

const KINDS: Record<RawError['kind'], FileErrorKind> = {
  BadRequest: 'bad-request',
  OutsideRepo: 'outside-repo',
  NotFound: 'not-found',
  TooLarge: 'too-large',
  ChangedOnDisk: 'changed-on-disk',
  ReadFailed: 'read-failed',
  WriteFailed: 'write-failed',
};

function isRawError(value: unknown): value is RawError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    typeof (value as { kind: unknown }).kind === 'string' &&
    (value as { kind: string }).kind in KINDS
  );
}

/**
 * Turns whatever came back from the command into a `FileError`.
 *
 * An unrecognized rejection becomes `write-failed`/`read-failed` rather than
 * being swallowed: the one thing that must never happen is a failed write that
 * the caller reads as success.
 */
function toFileError(raw: unknown, fallback: FileErrorKind): FileError {
  if (isRawError(raw)) return new FileError(KINDS[raw.kind], raw.message);
  return new FileError(fallback, raw instanceof Error ? raw.message : String(raw));
}

/** Opens a working-tree file for editing, or explains why it cannot be. */
export async function openWorktreeFile(repo: string, path: string): Promise<OpenFile> {
  let raw: RawContents;
  try {
    raw = await invoke<RawContents>('worktree_read', { repo, path });
  } catch (error) {
    throw toFileError(error, 'read-failed');
  }

  const refusal = refusalFor(raw.text, raw.lossy);
  if (refusal !== null) throw new FileError('not-editable', refusal);

  return {
    path,
    text: toEditor(raw.text),
    shape: readShape(raw.text),
    stamp: raw.stamp,
  };
}

/**
 * Writes the editor's text back, restoring the file's own shape.
 *
 * Returns the file as it now is on disk, so an editor left open can save again
 * without re-reading. `contents` is what the file will hold, exactly: nothing
 * downstream reformats it.
 */
export async function saveWorktreeFile(
  repo: string,
  file: OpenFile,
  contents: string,
): Promise<OpenFile> {
  let stamp: string;
  try {
    stamp = await invoke<string>('worktree_write', {
      repo,
      path: file.path,
      contents,
      expectStamp: file.stamp,
    });
  } catch (error) {
    throw toFileError(error, 'write-failed');
  }
  return { ...file, text: toEditor(contents), stamp };
}
