/**
 * Reads one version of an image for the diff panel's preview.
 *
 * Read only, both ways: a blob from the object store through `preview_blob`,
 * or a working-tree file through `preview_worktree`, which applies the
 * editor's path guard. The bytes come back as base64 and leave here as a data
 * URL — nothing is written to disk and nothing leaves the machine.
 */

import { invoke } from '@tauri-apps/api/core';
import { buildBlobSpec } from '../git/commands/blob';
import type { ImageSource } from '../views/diff/imageSides';

export interface LoadedImage {
  /** `data:<mime>;base64,…`, ready for an `<img src>`. */
  url: string;
  bytes: number;
}

interface RawPreview {
  base64: string;
  bytes: number;
}

/** Why a version could not be shown, in words the panel can print as is. */
export class PreviewError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = 'PreviewError';
    this.kind = kind;
  }
}

function toPreviewError(raw: unknown): PreviewError {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'kind' in raw &&
    'message' in raw &&
    typeof (raw as { kind: unknown }).kind === 'string'
  ) {
    const { kind, message } = raw as { kind: string; message: unknown };
    return new PreviewError(kind, String(message));
  }
  return new PreviewError('ReadFailed', raw instanceof Error ? raw.message : String(raw));
}

export async function loadImage(
  repo: string,
  source: ImageSource,
  mime: string,
): Promise<LoadedImage> {
  let raw: RawPreview;
  try {
    raw =
      source.from === 'worktree'
        ? await invoke<RawPreview>('preview_worktree', { repo, path: source.path })
        : await invoke<RawPreview>('preview_blob', {
            repo,
            spec: buildBlobSpec(source.source, source.path),
          });
  } catch (error) {
    throw toPreviewError(error);
  }
  return { url: `data:${mime};base64,${raw.base64}`, bytes: raw.bytes };
}
