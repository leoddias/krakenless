import { GitError } from '../errors';
import type { FileState, RepoStatus, StatusEntry } from '../types';

/**
 * No `args` is attached: the parser is pure and does not know which flags the
 * builder actually used, and a hand-copied argument list on the error would
 * name a command that was never run.
 */
function fail(message: string): never {
  throw new GitError('parse-failed', `git status: ${message}`);
}

/** Keeps a failure message bounded; a record can be as long as a path. */
function excerpt(record: string): string {
  return record.length > 120 ? `${record.slice(0, 120)}…` : record;
}

/**
 * Reads NUL-terminated records in order.
 *
 * Porcelain v2 with `-z` is *not* a flat list of NUL-separated records: a
 * rename or copy (`2 ...`) spends two records on one entry — the new path,
 * then the original path. Splitting the whole buffer on NUL and iterating
 * would read `oldname.txt` as the start of the next entry and shift every
 * following path by one. So the buffer is consumed with a cursor, and only the
 * record types that say so pull a second token.
 */
class RecordReader {
  private pos = 0;
  private readonly buffer: string;

  constructor(buffer: string) {
    this.buffer = buffer;
  }

  get done(): boolean {
    return this.pos >= this.buffer.length;
  }

  /**
   * Next record, without its terminator. Git terminates *every* record, so an
   * unterminated tail means the output was truncated — a path parsed out of it
   * would be a prefix of the real one, which is exactly the kind of value that
   * must never reach a write command.
   */
  next(): string {
    const end = this.buffer.indexOf('\0', this.pos);
    if (end === -1) {
      fail('output ends without a NUL terminator (truncated?)');
    }
    const record = this.buffer.slice(this.pos, end);
    this.pos = end + 1;
    return record;
  }
}

/**
 * Splits `count` space-separated fields off the front of a record and appends
 * the untouched remainder as the last element. The remainder is the path,
 * which may contain spaces — so it is never split.
 */
function fields(record: string, count: number): string[] {
  const out: string[] = [];
  let pos = 0;
  for (let i = 0; i < count; i += 1) {
    const space = record.indexOf(' ', pos);
    if (space === -1)
      fail(`record has fewer than ${count + 1} fields: ${excerpt(record)}`);
    out.push(record.slice(pos, space));
    pos = space + 1;
  }
  const rest = record.slice(pos);
  if (rest.length === 0) fail(`record has an empty path: ${excerpt(record)}`);
  out.push(rest);
  return out;
}

/** Indexed access with a loud failure instead of `undefined` leaking onward. */
function at(parts: string[], index: number, record: string): string {
  const value = parts[index];
  if (value === undefined) fail(`missing field ${index} in: ${excerpt(record)}`);
  return value;
}

const STATE_BY_CODE: Readonly<Record<string, FileState>> = {
  '.': 'unmodified',
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type-changed',
  U: 'unmerged',
};

function toState(code: string, record: string): FileState {
  const state = STATE_BY_CODE[code];
  if (state === undefined) {
    fail(`unknown state code ${JSON.stringify(code)} in: ${excerpt(record)}`);
  }
  return state;
}

/** `N...` for a regular file, `S<c><m><u>` for a submodule. */
function submoduleField(field: string, record: string): string | undefined {
  if (!/^(N\.\.\.|S[.C][.M][.U])$/.test(field)) {
    fail(`malformed submodule field ${JSON.stringify(field)} in: ${excerpt(record)}`);
  }
  return field.startsWith('S') ? field : undefined;
}

function assertMode(mode: string, record: string): void {
  if (!/^[0-7]{6}$/.test(mode)) {
    fail(`malformed file mode ${JSON.stringify(mode)} in: ${excerpt(record)}`);
  }
}

function assertOid(oid: string, record: string): void {
  // 40 hex digits for sha1, 64 for sha256; all-zero is git's "no object".
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(oid)) {
    fail(`malformed object id ${JSON.stringify(oid)} in: ${excerpt(record)}`);
  }
}

/** The `<X><Y>` state pair shared by all tracked-entry records. */
function statePair(
  xy: string,
  record: string,
): { index: FileState; worktree: FileState } {
  if (xy.length !== 2) {
    fail(
      `expected a two-letter status field, got ${JSON.stringify(xy)} in: ${excerpt(record)}`,
    );
  }
  return {
    index: toState(xy.charAt(0), record),
    worktree: toState(xy.charAt(1), record),
  };
}

/** `R100` / `C75` — the rename or copy similarity. */
function similarityOf(field: string, record: string): number {
  const match = /^[RC](\d{1,3})$/.exec(field);
  const digits = match === null ? undefined : match[1];
  if (digits === undefined) {
    fail(`malformed rename score ${JSON.stringify(field)} in: ${excerpt(record)}`);
  }
  const score = Number(digits);
  if (score > 100) fail(`rename score above 100 in: ${excerpt(record)}`);
  return score;
}

/** `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` */
function parseOrdinary(record: string): StatusEntry {
  const parts = fields(record.slice(2), 7);
  for (const index of [2, 3, 4]) assertMode(at(parts, index, record), record);
  for (const index of [5, 6]) assertOid(at(parts, index, record), record);
  const entry: StatusEntry = {
    path: at(parts, 7, record),
    ...statePair(at(parts, 0, record), record),
    conflicted: false,
  };
  const submodule = submoduleField(at(parts, 1, record), record);
  if (submodule !== undefined) entry.submodule = submodule;
  return entry;
}

/**
 * `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>` followed by a
 * second NUL-terminated record holding the source path.
 */
function parseRenamed(record: string, reader: RecordReader): StatusEntry {
  const parts = fields(record.slice(2), 8);
  for (const index of [2, 3, 4]) assertMode(at(parts, index, record), record);
  for (const index of [5, 6]) assertOid(at(parts, index, record), record);
  const similarity = similarityOf(at(parts, 7, record), record);
  const path = at(parts, 8, record);
  const origPath = reader.next();
  if (origPath.length === 0)
    fail(`rename record has an empty source path: ${excerpt(record)}`);
  const entry: StatusEntry = {
    path,
    origPath,
    ...statePair(at(parts, 0, record), record),
    similarity,
    conflicted: false,
  };
  const submodule = submoduleField(at(parts, 1, record), record);
  if (submodule !== undefined) entry.submodule = submodule;
  return entry;
}

/**
 * The seven conflict types porcelain v2 can report on a `u` record. This is a
 * *different* vocabulary from the `<XY>` of an ordinary entry: `UD` means
 * "modified by us, deleted by them", not "unmerged in the index, deleted in
 * the worktree".
 */
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/**
 * `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
 *
 * Both sides are reported as `unmerged`, never as the letters of the conflict
 * code. Mapping `UD` to `worktree: 'deleted'` would make a conflicted path
 * indistinguishable from an ordinary deletion, and a "discard working-tree
 * changes" action keyed on `worktree !== 'unmodified'` would then run checkout
 * against an unmerged index — collapsing the user's half-finished conflict
 * resolution to one stage, with nothing committed to recover from.
 */
function parseUnmerged(record: string): StatusEntry {
  const parts = fields(record.slice(2), 9);
  const code = at(parts, 0, record);
  if (!CONFLICT_CODES.has(code)) {
    fail(`unknown conflict code ${JSON.stringify(code)} in: ${excerpt(record)}`);
  }
  for (const index of [2, 3, 4, 5]) assertMode(at(parts, index, record), record);
  for (const index of [6, 7, 8]) assertOid(at(parts, index, record), record);
  const entry: StatusEntry = {
    path: at(parts, 9, record),
    index: 'unmerged',
    worktree: 'unmerged',
    conflicted: true,
    // Kept, not discarded: the resolution UI differs per conflict type.
    conflictKind: code as NonNullable<StatusEntry['conflictKind']>,
  };
  const submodule = submoduleField(at(parts, 1, record), record);
  if (submodule !== undefined) entry.submodule = submodule;
  return entry;
}

/**
 * `? <path>` / `! <path>`.
 *
 * The index side stays `unmodified` on purpose: nothing about these paths is
 * staged, so a view that lists staged changes as `index !== 'unmodified'` must
 * not pick them up and offer to unstage or commit them.
 */
function parseUnlisted(record: string, worktree: FileState): StatusEntry {
  const path = record.slice(2);
  if (path.length === 0) fail(`record has an empty path: ${excerpt(record)}`);
  return { path, index: 'unmodified', worktree, conflicted: false };
}

interface BranchHeaders {
  oid?: string;
  head?: string;
  upstream?: string;
  ahead: number;
  behind: number;
}

function parseHeader(record: string, headers: BranchHeaders): void {
  const space = record.indexOf(' ', 2);
  const key = space === -1 ? record.slice(2) : record.slice(2, space);
  const value = space === -1 ? '' : record.slice(space + 1);
  switch (key) {
    case 'branch.oid':
      if (value.length === 0) fail('empty # branch.oid header');
      headers.oid = value;
      return;
    case 'branch.head':
      if (value.length === 0) fail('empty # branch.head header');
      headers.head = value;
      return;
    case 'branch.upstream':
      if (value.length === 0) fail('empty # branch.upstream header');
      headers.upstream = value;
      return;
    case 'branch.ab': {
      const match = /^\+(\d+) -(\d+)$/.exec(value);
      const ahead = match === null ? undefined : match[1];
      const behind = match === null ? undefined : match[2];
      if (ahead === undefined || behind === undefined) {
        fail(`malformed # branch.ab header: ${JSON.stringify(value)}`);
      }
      headers.ahead = Number(ahead);
      headers.behind = Number(behind);
      return;
    }
    default:
      // Unknown headers (a future `# stash <n>`, say) are ignored rather than
      // fatal: a newer git must not break the status view.
      return;
  }
}

/**
 * Parses `git status --porcelain=v2 --branch -z` output into a
 * {@link RepoStatus}. Pure — takes the raw stdout string, touches no IPC.
 *
 * Throws {@link GitError} `parse-failed` on anything it does not fully
 * understand. Skipping an unreadable record would drop a modified file from
 * the list, and the user would commit or discard believing it is not there.
 */
export function parseStatus(stdout: string): RepoStatus {
  const reader = new RecordReader(stdout);
  const headers: BranchHeaders = { ahead: 0, behind: 0 };
  const entries: StatusEntry[] = [];

  while (!reader.done) {
    const record = reader.next();
    if (record.length === 0) fail('empty record');
    const kind = record.charAt(0);
    // Only entry records are required to have `<kind> ` framing; headers are
    // checked by parseHeader, which tolerates keys a newer git may add.
    if (kind !== '#' && record.charAt(1) !== ' ') {
      fail(`malformed record: ${JSON.stringify(excerpt(record))}`);
    }
    switch (kind) {
      case '#':
        parseHeader(record, headers);
        break;
      case '1':
        entries.push(parseOrdinary(record));
        break;
      case '2':
        entries.push(parseRenamed(record, reader));
        break;
      case 'u':
        entries.push(parseUnmerged(record));
        break;
      case '?':
        entries.push(parseUnlisted(record, 'untracked'));
        break;
      case '!':
        entries.push(parseUnlisted(record, 'ignored'));
        break;
      default:
        fail(`unknown record type ${JSON.stringify(kind)}`);
    }
  }

  if (headers.oid === undefined || headers.head === undefined) {
    fail('missing # branch.oid / # branch.head headers (was --branch passed?)');
  }
  // Ambiguity inherited from git's own format: a branch may legally be *named*
  // `(detached)`, and porcelain v2 gives no way to tell the two apart. Reading
  // it as detached is the conservative side — the UI then offers "create a
  // branch here" instead of assuming a branch is checked out.
  const detached = headers.head === '(detached)';
  const status: RepoStatus = {
    branch: detached ? null : headers.head,
    // `(initial)` is git's marker for a repository with no commits yet.
    head: headers.oid === '(initial)' ? null : headers.oid,
    detached,
    ahead: headers.ahead,
    behind: headers.behind,
    entries,
    hasConflicts: entries.some((entry) => entry.conflicted),
  };
  if (headers.upstream !== undefined) status.upstream = headers.upstream;
  return status;
}
