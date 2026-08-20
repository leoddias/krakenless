import {
  LOG_FIELD_COUNT,
  LOG_FIELD_SEPARATOR,
  LOG_RECORD_SEPARATOR,
} from '../commands/log';
import { GitError } from '../errors';
import type { Commit, CommitRef } from '../types';

const LOG_ARGS = ['log'];

/** SHA-1 (40) and SHA-256 (64) object names, plus abbreviations for `%h`. */
const FULL_OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const ABBREVIATED_OID = /^[0-9a-f]{4,64}$/;

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
      return name.length === 0 ? null : { kind, name };
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
      fail(`Unexpected parent object name in git log output: ${JSON.stringify(parent)}`);
    }
  }
  return parents;
}

function parseRecord(record: string): Commit {
  const fields = record.split(LOG_FIELD_SEPARATOR);
  if (fields.length !== LOG_FIELD_COUNT) {
    // The only way to get here with output from our own format is a commit
    // message containing a separator character. Guessing which field moved
    // would put a message fragment in an oid, so refuse instead.
    fail(
      `Expected ${LOG_FIELD_COUNT} fields per commit, got ${fields.length}; ` +
        'a commit message may contain the record separator',
    );
  }

  const field = (index: number): string => {
    const value = fields[index];
    // Unreachable after the length check above; keeps the types honest without
    // an assertion that could hide a real gap later.
    if (value === undefined) fail(`Missing field ${index} in git log output`);
    return value;
  };

  const oid = field(0);
  const shortOid = field(1);
  const authorDate = field(5);
  const committerDate = field(7);

  if (!FULL_OID.test(oid)) {
    fail(`Unexpected object name in git log output: ${JSON.stringify(oid)}`);
  }
  if (!ABBREVIATED_OID.test(shortOid)) {
    fail(
      `Unexpected abbreviated object name in git log output: ${JSON.stringify(shortOid)}`,
    );
  }
  if (authorDate.length === 0 || committerDate.length === 0) {
    fail(`git log returned a commit without dates: ${oid}`);
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
    // `%b` keeps the message's own trailing newlines and git appends one more
    // after every record. Trailing blank lines are formatting, not content;
    // interior blank lines and CRLF are kept verbatim.
    body: field(10).replace(/(?:\r?\n)+$/, ''),
    refs: parseDecorations(field(8)),
  };
}

/**
 * Parses the stdout of {@link buildLogCommand} into commits, newest first.
 *
 * Pure: takes the whole output as a string, throws {@link GitError}
 * `parse-failed` on anything it does not fully understand.
 */
export function parseLog(stdout: string): Commit[] {
  // An empty history is legitimately empty output (`git log --all` in a fresh
  // repository exits 0 with nothing to say).
  if (stdout.length === 0 || stdout.trim().length === 0) return [];

  const chunks = stdout.split(LOG_RECORD_SEPARATOR);
  // The separator is a prefix of every record, so everything before the first
  // one must be empty. Anything else is output we did not produce.
  if (chunks[0] !== '') {
    fail('git log output did not start with the record separator');
  }

  return chunks.slice(1).map(parseRecord);
}
