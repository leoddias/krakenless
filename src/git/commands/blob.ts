/**
 * Names one version of a file in the object store, for the image preview.
 *
 * Not a git command of its own: the spec is handed to the Rust side, which runs
 * `cat-file` with it and checks it against the same grammar. A spec is a
 * *revision*, so it travels as one argument with no `--` in front of it — which
 * is why every part of it is checked before it is spliced together.
 */

import { assertOid, assertPath } from '../argsafety';

/** Which store a version is read from. */
export type BlobSource =
  /** Stage 0 of the index: what is staged. */
  | { kind: 'index' }
  /** The commit `HEAD` names now. */
  | { kind: 'head' }
  /** A commit by full oid, or its first parent with `parent: true`. */
  | { kind: 'commit'; oid: string; parent?: boolean };

/** `:path`, `HEAD:path`, `<oid>:path` or `<oid>^:path`. */
export function buildBlobSpec(source: BlobSource, path: string): string {
  const checked = assertPath(path);
  switch (source.kind) {
    case 'index':
      return `:${checked}`;
    case 'head':
      return `HEAD:${checked}`;
    case 'commit':
      // `^` is the first parent — the same parent the commit's diff is taken
      // against (`show -m --first-parent`), so the two sides match the diff.
      return `${assertOid(source.oid)}${source.parent === true ? '^' : ''}:${checked}`;
  }
}
