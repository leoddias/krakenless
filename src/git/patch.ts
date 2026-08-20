/**
 * Turns parsed hunks back into a patch `git apply --cached` accepts.
 *
 * This is the most dangerous pure function in the app. A patch that applies but
 * is subtly wrong stages content the user never chose; a patch whose counts
 * disagree with its body can leave the index half-written. So: the serializer
 * recomputes every count from the lines it actually emits, never trusting the
 * numbers it parsed, and the caller runs `git apply --check` before the real
 * apply (see `src/git/stage.ts`).
 */

import { GitError } from './errors';
import type { DiffLine, FileDiff, Hunk } from './types';

/** Marker git writes when a side's last line has no trailing newline. */
const NO_NEWLINE = '\\ No newline at end of file';

function fail(message: string): never {
  throw new GitError('parse-failed', message);
}

/**
 * Header lines identifying the file, rebuilt rather than reused: the parsed
 * `headerLines` may carry `index`/`mode` lines that no longer describe the
 * subset of hunks being staged.
 */
const DEFAULT_MODE = '100644';

function fileHeader(file: FileDiff): string[] {
  const oldSide = file.kind === 'added' ? '/dev/null' : `a/${file.oldPath}`;
  const newSide = file.kind === 'deleted' ? '/dev/null' : `b/${file.newPath}`;
  const lines = [`diff --git a/${file.oldPath} b/${file.newPath}`];

  // Modes are re-emitted from what git reported. Guessing 100644 for a file
  // that is executable — or a symlink — stages something other than what the
  // user is looking at.
  if (file.kind === 'added') {
    lines.push(`new file mode ${file.newMode ?? DEFAULT_MODE}`);
  } else if (file.kind === 'deleted') {
    lines.push(`deleted file mode ${file.oldMode ?? DEFAULT_MODE}`);
  } else if (file.oldMode !== undefined && file.newMode !== undefined) {
    lines.push(`old mode ${file.oldMode}`, `new mode ${file.newMode}`);
  }

  lines.push(`--- ${oldSide}`, `+++ ${newSide}`);
  return lines;
}

/**
 * Paths git would have to C-quote in the `---`/`+++` lines. Git's own parsing
 * of those lines is heuristic, so rather than reproduce the quoting we refuse
 * to build a patch at all — the caller falls back to whole-file staging.
 */
const UNQUOTABLE_PATH = /["\\\t\n]/;

interface HunkBody {
  lines: string[];
  oldCount: number;
  newCount: number;
}

function renderLine(line: DiffLine): string {
  switch (line.kind) {
    case 'context':
      return ` ${line.text}`;
    case 'added':
      return `+${line.text}`;
    case 'deleted':
      return `-${line.text}`;
    case 'no-newline':
      return NO_NEWLINE;
  }
}

function renderBody(hunk: Hunk): HunkBody {
  const lines: string[] = [];
  let oldCount = 0;
  let newCount = 0;

  for (const line of hunk.lines) {
    lines.push(renderLine(line));
    switch (line.kind) {
      case 'context':
        oldCount += 1;
        newCount += 1;
        break;
      case 'deleted':
        oldCount += 1;
        break;
      case 'added':
        newCount += 1;
        break;
      case 'no-newline':
        // Belongs to the line above; it counts for neither side.
        break;
    }
  }
  return { lines, oldCount, newCount };
}

/**
 * `@@ -a,b +c,d @@`. Git omits the count when it is 1 and writes a start of 0
 * for an empty side; reproducing both exactly is what makes the patch apply.
 */
function renderHeader(
  oldStart: number,
  oldCount: number,
  newStart: number,
  newCount: number,
): string {
  const oldRange = oldCount === 1 ? `${oldStart}` : `${oldStart},${oldCount}`;
  const newRange = newCount === 1 ? `${newStart}` : `${newStart},${newCount}`;
  return `@@ -${oldRange} +${newRange} @@`;
}

/**
 * Start line on the new side.
 *
 * Git's convention for the degenerate sides is not "the same number": a pure
 * insertion after old line k is `@@ -k,0 +k+1,n @@`, and a deletion starting at
 * old line k is `@@ -k,m +k-1,0 @@`. `newOffset` carries the shift introduced by
 * the hunks already emitted — without it, the second selected hunk of a partial
 * stage lands at the wrong place in the file.
 */
function newStartOf(hunk: Hunk, body: HunkBody, newOffset: number): number {
  if (body.oldCount === 0) return hunk.oldStart + newOffset + 1;
  if (body.newCount === 0) return hunk.oldStart + newOffset - 1;
  return hunk.oldStart + newOffset;
}

/**
 * Serializes selected hunks of one file into a patch.
 *
 * When only some hunks are selected the later ones sit at the wrong offset on
 * the new side, because the earlier, unselected hunks are not being applied.
 * The offset is corrected here; getting it wrong is how a partial stage writes
 * content into the wrong place in the file.
 */
export function serializeHunks(file: FileDiff, hunks: Hunk[]): string {
  if (file.binary) {
    fail(`Cannot build a patch for the binary file ${file.newPath}`);
  }
  if (file.conflicted) {
    fail(`Cannot build a patch for the conflicted file ${file.newPath}`);
  }
  if (file.kind === 'renamed' || file.kind === 'copied') {
    // Git infers a rename from the differing paths in the header, so a patch
    // carrying only some hunks would un-rename the file in the index while
    // leaving the other hunks applied to the old path.
    fail(`Hunk-level staging is not supported for the ${file.kind} file ${file.newPath}`);
  }
  if (UNQUOTABLE_PATH.test(file.oldPath) || UNQUOTABLE_PATH.test(file.newPath)) {
    fail(`Cannot build a patch for a path containing quotes, tabs or newlines`);
  }
  if (hunks.length === 0) {
    fail(`No hunks selected for ${file.newPath}`);
  }

  const lines = fileHeader(file);
  let newOffset = 0;

  for (const hunk of hunks) {
    const body = renderBody(hunk);
    if (body.lines.length === 0) {
      fail(`Hunk ${hunk.header} in ${file.newPath} has no lines`);
    }
    lines.push(
      renderHeader(
        hunk.oldStart,
        body.oldCount,
        newStartOf(hunk, body, newOffset),
        body.newCount,
      ),
    );
    lines.push(...body.lines);
    newOffset += body.newCount - body.oldCount;
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Patch that stages every hunk of a file, in the order git produced them.
 * Equivalent to `git add <path>` but goes through the same code path as a
 * partial stage, so both are exercised by the same tests.
 */
export function serializeFile(file: FileDiff): string {
  return serializeHunks(file, file.hunks);
}
