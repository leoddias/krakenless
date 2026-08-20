import { GitError } from '../errors';
import type { DiffLine, FileChangeKind, FileDiff, Hunk } from '../types';

/**
 * Parser for git's unified patch format.
 *
 * Written against real output from git 2.39 (see `diff.test.ts`, where every
 * fixture is a verbatim capture rather than something hand-written). Three
 * properties matter more than leniency, because M2 hands these hunks back to
 * `git apply --cached`:
 *
 * 1. **Verbatim content.** Line text keeps its bytes, including a trailing
 *    `\r` from a CRLF file. Nothing is trimmed or normalised.
 * 2. **Verbatim hunk headers.** `Hunk.header` is the `@@` line as git wrote
 *    it, trailing function context included, so it round-trips exactly.
 * 3. **Loud failure.** Anything unrecognised throws `parse-failed`. A patch
 *    that is half-understood is worse than no patch at all.
 */

const FILE_HEADER = 'diff --git ';
const COMBINED_HEADERS = ['diff --cc ', 'diff --combined '];

function fail(message: string): never {
  throw new GitError('parse-failed', message, { args: ['diff'] });
}

// --- c-style quoting --------------------------------------------------------

const C_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  '\\': 0x5c,
  '"': 0x22,
};

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

/**
 * Reverses git's `quote_c_style`. Git quotes a path whenever it contains a
 * control character, a double quote or a backslash — and, when
 * `core.quotePath` is on, every non-ASCII byte as a `\nnn` octal escape. The
 * runner turns `core.quotePath` off, but a repository-local or command-line
 * override must not silently produce paths like `caf\303\251.txt`.
 *
 * Escapes decode to *bytes*, which are then read back as UTF-8 — decoding them
 * one by one would turn `\303\251` into two Latin-1 characters.
 */
function unquoteCStyle(token: string): string {
  if (!token.startsWith('"') || !token.endsWith('"') || token.length < 2) {
    fail(`Malformed quoted path in diff header: ${JSON.stringify(token)}`);
  }
  const bytes: number[] = [];
  let i = 1;
  const end = token.length - 1;
  while (i < end) {
    const char = token[i] as string;
    if (char !== '\\') {
      bytes.push(...utf8Encoder.encode(char));
      i += 1;
      continue;
    }
    const escape = token[i + 1];
    if (escape === undefined) {
      fail(`Truncated escape in quoted path: ${JSON.stringify(token)}`);
    }
    if (escape >= '0' && escape <= '7') {
      const octal = token.slice(i + 1, i + 4);
      if (!/^[0-7]{3}$/.test(octal)) {
        fail(`Malformed octal escape in quoted path: ${JSON.stringify(token)}`);
      }
      bytes.push(Number.parseInt(octal, 8));
      i += 4;
      continue;
    }
    const known = C_ESCAPES[escape];
    if (known === undefined) {
      fail(`Unknown escape \\${escape} in quoted path: ${JSON.stringify(token)}`);
    }
    bytes.push(known);
    i += 2;
  }
  return utf8Decoder.decode(new Uint8Array(bytes));
}

/** Index just past the closing quote of a c-quoted token starting at `from`. */
function endOfQuotedToken(line: string, from: number): number {
  let i = from + 1;
  while (i < line.length) {
    const char = line[i];
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (char === '"') return i + 1;
    i += 1;
  }
  return fail(`Unterminated quoted path: ${JSON.stringify(line)}`);
}

/** Decodes a path field that may or may not be quoted. */
function decodePath(token: string): string {
  return token.startsWith('"') ? unquoteCStyle(token) : token;
}

function stripPrefix(path: string, prefix: 'a/' | 'b/'): string {
  if (!path.startsWith(prefix)) {
    fail(`Diff path is missing its "${prefix}" prefix: ${JSON.stringify(path)}`);
  }
  return path.slice(prefix.length);
}

// --- header lines -----------------------------------------------------------

/**
 * Reads a `--- a/x` or `+++ b/x` line. Returns `null` for `/dev/null`, which
 * is how git spells "this side does not exist".
 *
 * Git appends a literal tab when the name contains a space (`--- a/my file.txt\t`),
 * placing it *after* the closing quote when the name is also quoted. A name
 * that really ends in a tab is always quoted, so stripping one trailing tab
 * before unquoting can never eat a real character.
 */
function parseSidePath(line: string, prefix: 'a/' | 'b/'): string | null {
  let value = line.slice(4);
  if (value === '/dev/null') return null;
  if (value.endsWith('\t')) value = value.slice(0, -1);
  return stripPrefix(decodePath(value), prefix);
}

/**
 * Reads the two paths out of a `diff --git` line.
 *
 * This line is genuinely ambiguous: git separates the names with a space and
 * does *not* quote them for spaces alone, so `diff --git a/my file.txt b/my
 * file.txt` has several readings. It is only used as a fallback, for the
 * entries git emits without `---`/`+++` lines (mode-only changes, pure
 * renames, binary files, empty new files) — and in all of those either both
 * names are identical or `rename from`/`rename to` already gave the answer.
 * When the split is not decidable, this throws rather than guesses.
 */
function parseFileHeaderPaths(line: string): { oldPath: string; newPath: string } {
  const rest = line.slice(FILE_HEADER.length);
  if (rest.startsWith('"')) {
    // Git quotes both names when either one needs it, so a leading quote means
    // the line is unambiguous: token, space, token.
    const split = endOfQuotedToken(rest, 0);
    if (rest[split] !== ' ') {
      fail(`Malformed diff header: ${JSON.stringify(line)}`);
    }
    return {
      oldPath: stripPrefix(unquoteCStyle(rest.slice(0, split)), 'a/'),
      newPath: stripPrefix(decodePath(rest.slice(split + 1)), 'b/'),
    };
  }

  // Same name on both sides: `a/<p> b/<p>` splits exactly in the middle.
  const middle = (rest.length - 1) / 2;
  if (
    Number.isInteger(middle) &&
    rest[middle] === ' ' &&
    rest.slice(0, middle).startsWith('a/') &&
    rest.slice(middle + 1).startsWith('b/') &&
    rest.slice(2, middle) === rest.slice(middle + 3)
  ) {
    const path = rest.slice(2, middle);
    return { oldPath: path, newPath: path };
  }

  const candidates: number[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === ' ' && rest.startsWith('b/', i + 1)) candidates.push(i);
  }
  const only = candidates.length === 1 ? candidates[0] : undefined;
  if (only === undefined) {
    fail(`Cannot split the paths in a diff header: ${JSON.stringify(line)}`);
  }
  return {
    oldPath: stripPrefix(rest.slice(0, only), 'a/'),
    newPath: stripPrefix(rest.slice(only + 1), 'b/'),
  };
}

// --- hunks ------------------------------------------------------------------

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface HunkCounts {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

function parseHunkHeader(line: string): HunkCounts {
  const match = HUNK_HEADER.exec(line);
  if (match === null) {
    fail(`Malformed hunk header: ${JSON.stringify(line)}`);
  }
  // A missing count means one line: `@@ -1 +1 @@`.
  return {
    oldStart: Number(match[1]),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
  };
}

/**
 * Consumes one hunk body. Stops as soon as both sides are satisfied, so the
 * counts declared in the header are enforced rather than trusted — a body that
 * is longer or shorter than its header claims would be a patch `git apply`
 * rejects, and we would rather find out here.
 */
function parseHunkBody(
  lines: string[],
  from: number,
  counts: HunkCounts,
): { lines: DiffLine[]; next: number } {
  const body: DiffLine[] = [];
  let oldNo = counts.oldStart;
  let newNo = counts.newStart;
  let oldLeft = counts.oldLines;
  let newLeft = counts.newLines;
  let i = from;

  const takeNoNewlineMarker = (): boolean => {
    const line = lines[i];
    if (line === undefined || !line.startsWith('\\')) return false;
    // The message after `\ ` is git's, not ours; keep it verbatim.
    body.push({ kind: 'no-newline', text: line.slice(2) });
    i += 1;
    return true;
  };

  while (oldLeft > 0 || newLeft > 0) {
    const line = lines[i];
    if (line === undefined) {
      fail(`Hunk ends before its declared line count: ${JSON.stringify(counts)}`);
    }
    if (takeNoNewlineMarker()) continue;
    const text = line.slice(1);
    switch (line[0]) {
      case ' ':
        if (oldLeft === 0 || newLeft === 0) fail('Context line past the hunk counts');
        body.push({ kind: 'context', text, oldLine: oldNo, newLine: newNo });
        oldNo += 1;
        newNo += 1;
        oldLeft -= 1;
        newLeft -= 1;
        break;
      case '+':
        if (newLeft === 0) fail('Added line past the hunk counts');
        body.push({ kind: 'added', text, newLine: newNo });
        newNo += 1;
        newLeft -= 1;
        break;
      case '-':
        if (oldLeft === 0) fail('Deleted line past the hunk counts');
        body.push({ kind: 'deleted', text, oldLine: oldNo });
        oldNo += 1;
        oldLeft -= 1;
        break;
      default:
        fail(`Unexpected line inside a hunk: ${JSON.stringify(line)}`);
    }
    i += 1;
  }
  // A `\ No newline at end of file` belonging to the hunk's final line.
  takeNoNewlineMarker();

  return { lines: body, next: i };
}

// --- files ------------------------------------------------------------------

interface HeaderFacts {
  kind: FileChangeKind;
  binary: boolean;
  oldPath?: string;
  newPath?: string;
}

function readHeaderLine(line: string, facts: HeaderFacts): void {
  if (line.startsWith('new file mode ')) {
    facts.kind = 'added';
  } else if (line.startsWith('deleted file mode ')) {
    facts.kind = 'deleted';
  } else if (line.startsWith('rename from ')) {
    facts.kind = 'renamed';
    facts.oldPath = decodePath(line.slice('rename from '.length));
  } else if (line.startsWith('rename to ')) {
    facts.kind = 'renamed';
    facts.newPath = decodePath(line.slice('rename to '.length));
  } else if (line.startsWith('copy from ')) {
    facts.kind = 'copied';
    facts.oldPath = decodePath(line.slice('copy from '.length));
  } else if (line.startsWith('copy to ')) {
    facts.kind = 'copied';
    facts.newPath = decodePath(line.slice('copy to '.length));
  } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
    facts.binary = true;
  } else if (line.startsWith('--- ')) {
    const path = parseSidePath(line, 'a/');
    if (path !== null) facts.oldPath = path;
  } else if (line.startsWith('+++ ')) {
    const path = parseSidePath(line, 'b/');
    if (path !== null) facts.newPath = path;
  }
}

function rejectCombined(line: string): void {
  if (COMBINED_HEADERS.some((header) => line.startsWith(header))) {
    fail(
      'Combined (merge) diffs are not supported; ask git for a two-side patch ' +
        `instead: ${JSON.stringify(line)}`,
    );
  }
}

/**
 * Turns unified diff text into one {@link FileDiff} per file.
 *
 * Note on `type-changed`: git's patch format has no single entry for it. A
 * symlink that becomes a regular file is emitted as a delete followed by an
 * add (verified against git 2.39, where `--raw` reports `T` for the same
 * change), so this parser never produces that kind — the status parser does.
 */
export function parseDiff(text: string): FileDiff[] {
  if (text.length === 0) return [];

  const lines = text.split('\n');
  // Git terminates every line it writes, leaving one empty trailing element.
  if (lines[lines.length - 1] === '') lines.pop();

  const files: FileDiff[] = [];
  let i = 0;

  // `git show` without `--format=` prints the commit header first. Skipping it
  // is safe: a content line never starts at column 0 without a marker.
  while (i < lines.length && !(lines[i] as string).startsWith(FILE_HEADER)) {
    rejectCombined(lines[i] as string);
    i += 1;
  }

  while (i < lines.length) {
    const headerLine = lines[i] as string;
    const headerLines: string[] = [headerLine];
    const facts: HeaderFacts = { kind: 'modified', binary: false };
    i += 1;

    while (i < lines.length) {
      const line = lines[i] as string;
      if (line.startsWith(FILE_HEADER) || line.startsWith('@@ ')) break;
      rejectCombined(line);
      readHeaderLine(line, facts);
      headerLines.push(line);
      i += 1;
    }

    const hunks: Hunk[] = [];
    while (i < lines.length && (lines[i] as string).startsWith('@@ ')) {
      const header = lines[i] as string;
      const counts = parseHunkHeader(header);
      const body = parseHunkBody(lines, i + 1, counts);
      hunks.push({ header, ...counts, lines: body.lines });
      i = body.next;
    }

    if (i < lines.length && !(lines[i] as string).startsWith(FILE_HEADER)) {
      fail(`Unexpected line between files: ${JSON.stringify(lines[i])}`);
    }

    // No `---`/`+++` lines for mode-only changes, pure renames, binary files
    // and empty new files; the `diff --git` line is the only path source left.
    // Read it only when something is still missing — it is the ambiguous one.
    let oldPath = facts.oldPath;
    let newPath = facts.newPath;
    if (oldPath === undefined || newPath === undefined) {
      const fallback = parseFileHeaderPaths(headerLine);
      oldPath ??= fallback.oldPath;
      newPath ??= fallback.newPath;
    }

    files.push({
      oldPath,
      newPath,
      kind: facts.kind,
      binary: facts.binary,
      headerLines,
      hunks,
    });
  }

  return files;
}
