import {
  buildCommitDiffCommand,
  buildStagedDiffCommand,
  buildWorktreeDiffCommand,
  type DiffOptions,
} from './commands/diff';
import { parseDiff } from './parsers/diff';
import { runGit } from './runner';
import type { DiffSide, FileDiff, GitCommand } from './types';

export type { DiffOptions } from './commands/diff';

/**
 * Thin async layer over the diff builders and the parser.
 *
 * Lossy output is deliberately *not* allowed. A file whose bytes are not valid
 * UTF-8 (a Latin-1 source file, say) would come back with replacement
 * characters, and a patch built from those characters no longer matches the
 * blob it claims to patch — staging it would rewrite the file's contents.
 * The runner therefore throws `GitError('undecodable-output')` for such a
 * file, and the UI is expected to show "this diff cannot be displayed" rather
 * than a plausible-looking lie. Binary files are unaffected: without
 * `--binary` git only prints `Binary files … differ`, which is pure ASCII.
 */
async function diff(
  repo: string,
  command: GitCommand,
  side: DiffSide,
): Promise<FileDiff[]> {
  const output = await runGit(repo, command);
  // Stamped here, at the only place that knows which command produced the
  // text: the patch itself reads the same whichever comparison it came from,
  // and the side is what later decides staging direction.
  return parseDiff(output.stdout).map((file) => ({ ...file, side }));
}

/** Unstaged changes: working tree against the index. */
export function getWorktreeDiff(
  repo: string,
  options: DiffOptions = {},
): Promise<FileDiff[]> {
  return diff(repo, buildWorktreeDiffCommand(options), 'unstaged');
}

/** Staged changes: index against HEAD. */
export function getStagedDiff(
  repo: string,
  options: DiffOptions = {},
): Promise<FileDiff[]> {
  return diff(repo, buildStagedDiffCommand(options), 'staged');
}

/** The patch a single commit introduced, against its first parent. */
export function getCommitDiff(
  repo: string,
  rev: string,
  options: DiffOptions = {},
): Promise<FileDiff[]> {
  return diff(repo, buildCommitDiffCommand(rev, options), 'commit');
}
