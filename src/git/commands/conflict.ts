/**
 * Builders for reading and resolving a conflicted path.
 *
 * The read side takes its content from the index rather than from the working
 * tree: the marked-up file on disk is ambiguous — a file may legitimately
 * contain a line of seven angle brackets — while the index stages are exactly
 * what each side had.
 */

import { assertPath } from '../argsafety';
import type { GitCommand } from '../types';

/**
 * Reads one stage of a conflicted path: 1 is the ancestor, 2 ours, 3 theirs.
 *
 * `--textconv` is deliberately absent. A filter that turns a binary into
 * readable text is a display convenience, and a resolution built out of its
 * output would be written back as the file itself.
 */
export function buildShowStageCommand(stage: 1 | 2 | 3, path: string): GitCommand {
  // `:N:path` is the index-stage syntax, and it is a *revision*, not a
  // pathspec: it travels as one argument with no `--` in front of it, so the
  // path inside it is checked before it is spliced in.
  return { args: ['show', `:${String(stage)}:${assertPath(path)}`] };
}
