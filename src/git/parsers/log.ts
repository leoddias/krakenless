import { LOG_FIELD_COUNT, LOG_SEPARATOR } from '../commands/log';
import { GitError } from '../errors';
import type { Commit, CommitRef } from '../types';

const LOG_ARGS = ['log'];

/** SHA-1 (40) and SHA-256 (64) object names, plus abbreviations for `%h`. */
const FULL_OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const ABBREVIATED_OID = /^[0-9a-f]{4,64}$/;

/** What `%aI`/`%cI` emit: strict ISO 8601 with an explicit offset. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Parse errors describe the *shape* of what arrived, never its content: a
 * misaligned stream puts commit message text in these fields, and messages are
 * private data that must not end up in a log line.
 */
function fail(message: string): never {
  throw new GitError('parse-failed', message, { args: LOG_ARGS });
}

/**
 * Turns one `%D` decoration into a typed ref.
 *
 * The builder always asks for `--decorate=full`, so every ref we can represent
 * arrives with its full path. Anything else — `refs/stash`, `refs/notes/*`,
 * `grafted`, `replaced` — has no {@link RefKind} and is dropped: those really
 * do show up in `git log --all` output (verified with git 2.39), and refusing
 * to parse the whole history because of a stash entry would be a worse lie
 * than omitting a chip the UI cannot draw anyway.
 */
function classifyRef(ref: string): CommitRef | null {
  const prefixes = [
    ['refs/heads/', 'branch'],
    ['refs/remotes/', 'remote-branch'],
    ['refs/tags/', 'tag'],
  ] as const;

  for (const [prefix, kind] of prefixes) {
    if (ref.startsWith(prefix)) {
      const name = ref.slice(prefix.length);
      if (name.length === 0) return null;
      // `refs/remotes/<remote>/HEAD` is the symref recording the remote's
      // default branch, present in every clone. Drawing it as a branch chip
      // would offer the user a branch that cannot be checked out by that name.
      if (kind === 'remote-branch' && name.endsWith('/HEAD')) return null;
      return { kind, name };
    }
  }
  return null;
}

/**
 * Parses the `%D` field.
 *
 * Decorations are joined with `", "`. A ref name may legally contain a comma
 * (`refs/heads/comma,name` is a real branch), but never a space — git rejects
 * those — so the comma-*space* pair is an unambiguous delimiter.
 *
 * `HEAD -> refs/heads/main` yields two refs: the HEAD marker and the branch it
 * points at. That keeps "which branch is checked out" derivable without
 * inventing a ref kind the contract does not have.
 */
export function parseDecorations(field: string): CommitRef[] {
  const trimmed = field.trim();
  if (trimmed.length === 0) return [];

  const refs: CommitRef[] = [];
  for (const token of trimmed.split(', ')) {
    if (token === 'HEAD') {
      refs.push({ kind: 'head', name: 'HEAD' });
      continue;
    }
    if (token.startsWith('HEAD -> ')) {
      refs.push({ kind: 'head', name: 'HEAD' });
      const target = classifyRef(token.slice('HEAD -> '.length));
      if (target) refs.push(target);
      continue;
    }
    if (token.startsWith('tag: ')) {
      const tag = classifyRef(token.slice('tag: '.length));
      // `tag:` is only ever emitted for refs/tags/*; anything else here means
      // the output did not come from the builder's format.
      if (tag && tag.kind === 'tag') refs.push(tag);
      continue;
    }
    const ref = classifyRef(token);
    if (ref) refs.push(ref);
  }
  return refs;
}

function parseParents(field: string): string[] {
  if (field.length === 0) return []; // root commit
  const parents = field.split(' ');
  for (const parent of parents) {
    if (!FULL_OID.test(parent)) {
      fail(`Unexpected parent object name in git log output (${parent.length} chars)`);
    }
  }
  return parents;
}

function parseRecord(fields: string[]): Commit {
  const field = (index: number): string => {
    const value = fields[index];
    // Unreachable: records are sliced at exactly LOG_FIELD_COUNT. Kept so the
    // types stay honest without an assertion that could hide a real gap.
    if (value === undefined) fail(`Missing field ${index} in git log output`);
    return value;
  };

  const oid = field(0);
  const shortOid = field(1);
  const authorDate = field(5);
  const committerDate = field(7);

  // These four are what tells a correctly aligned stream from a shifted one.
  // Everything after them is free text that cannot be validated, so if the
  // alignment is wrong it has to be caught here.
  if (!FULL_OID.test(oid)) {
    fail(`Unexpected object name in git log output (${oid.length} chars)`);
  }
  if (!ABBREVIATED_OID.test(shortOid)) {
    fail(
      `Unexpected abbreviated object name in git log output (${shortOid.length} chars)`,
    );
  }
  if (!ISO_DATE.test(authorDate) || !ISO_DATE.test(committerDate)) {
    fail(`git log returned a commit without ISO 8601 dates: ${oid}`);
  }

  return {
    oid,
    shortOid,
    parents: parseParents(field(2)),
    authorName: field(3),
    authorEmail: field(4),
    authorDate,
    committerName: field(6),
    committerDate,
    subject: field(9),
    // `%b` keeps the message's own trailing newlines. Trailing blank lines are
    // formatting, not content; interior blank lines and CRLF stay verbatim.
    body: field(10).replace(/(?:\r?\n)+$/, ''),
    refs: parseDecorations(field(8)),
  };
}

/**
 * Parses the stdout of `buildLogCommand` into commits, newest first.
 *
 * Pure: takes the whole output as a string, throws {@link GitError}
 * `parse-failed` on anything it does not fully understand. With `-z` the
 * output is a flat NUL-separated stream, so the only thing to check is that it
 * divides evenly into records — a commit message cannot contain a NUL, so it
 * cannot shift a boundary.
 */
export function parseLog(stdout: string): Commit[] {
  // An empty history is legitimately empty output (`git log --all` in a fresh
  // repository exits 0 with nothing to say).
  if (stdout.length === 0) return [];

  const tokens = stdout.split(LOG_SEPARATOR);
  // `-z` terminates the last record too, which leaves one trailing empty item.
  if (tokens.pop() !== '') {
    fail('git log output did not end with the record terminator');
  }
  if (tokens.length === 0 || tokens.length % LOG_FIELD_COUNT !== 0) {
    fail(
      `git log returned ${tokens.length} fields, not a multiple of ${LOG_FIELD_COUNT}`,
    );
  }

  const commits: Commit[] = [];
  for (let start = 0; start < tokens.length; start += LOG_FIELD_COUNT) {
    commits.push(parseRecord(tokens.slice(start, start + LOG_FIELD_COUNT)));
  }
  return commits;
}
