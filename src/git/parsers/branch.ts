import { GitError } from '../errors';
import type { Branch, Remote, StashEntry } from '../types';

const FIELDS_PER_BRANCH = 6;

function fail(message: string): never {
  throw new GitError('parse-failed', message);
}

/**
 * `%(upstream:track)` looks like `[ahead 2, behind 1]`, `[ahead 3]`,
 * `[behind 4]`, `[gone]`, or is empty. Parsed rather than trusted: a wrong
 * ahead/behind count is what makes a user force-push over someone else's work.
 */
export function parseTracking(track: string): {
  ahead: number;
  behind: number;
  gone: boolean;
} {
  if (track.trim().length === 0) return { ahead: 0, behind: 0, gone: false };
  if (track.includes('gone')) return { ahead: 0, behind: 0, gone: true };

  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return {
    ahead: ahead === null ? 0 : Number(ahead[1]),
    behind: behind === null ? 0 : Number(behind[1]),
    gone: false,
  };
}

/** Parses `for-each-ref` output built with {@link BRANCH_FORMAT}. */
export function parseBranches(stdout: string): Branch[] {
  const branches: Branch[] = [];

  for (const line of stdout.split('\n')) {
    const record = line.replace(/\r$/, '');
    if (record.length === 0) continue;

    const fields = record.split('\0');
    if (fields.length !== FIELDS_PER_BRANCH) {
      fail(`Expected ${FIELDS_PER_BRANCH} fields per branch, got ${fields.length}`);
    }
    const [fullRef, name, oid, head, upstream, track] = fields as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (name.length === 0 || oid.length === 0) {
      fail('Branch record is missing a name or object id');
    }

    const tracking = parseTracking(track);
    const branch: Branch = {
      name,
      oid,
      // `%(HEAD)` is `*` for the checked-out branch and a space otherwise.
      current: head.trim() === '*',
      ahead: tracking.ahead,
      behind: tracking.behind,
      // A local branch may be named `feature/x`; only the ref prefix decides.
      remote: fullRef.startsWith('refs/remotes/'),
    };
    // A `gone` upstream is not an upstream any more; reporting it would offer
    // a push to a branch that no longer exists.
    if (upstream.length > 0 && !tracking.gone) branch.upstream = upstream;
    branches.push(branch);
  }

  return branches;
}

/**
 * Parses `git remote --verbose`: two lines per remote (fetch and push), each
 * `name<TAB>url (direction)`.
 */
export function parseRemotes(stdout: string): Remote[] {
  const byName = new Map<string, Remote>();

  for (const line of stdout.split('\n')) {
    const record = line.replace(/\r$/, '');
    if (record.length === 0) continue;

    const match = /^(\S+)\t(.*) \((fetch|push)\)$/.exec(record);
    if (match === null) fail(`Unrecognized remote line: ${record.slice(0, 80)}`);
    const [, name, url, direction] = match as unknown as [string, string, string, string];

    const existing = byName.get(name) ?? { name, fetchUrl: '', pushUrl: '' };
    if (direction === 'fetch') existing.fetchUrl = url;
    else existing.pushUrl = url;
    byName.set(name, existing);
  }

  return [...byName.values()];
}

const FIELDS_PER_STASH = 4;

/**
 * Parses the NUL-separated stash list built in `commands/stage.ts`.
 *
 * `git stash list -z` separates *everything* with NUL — fields and records
 * alike — and terminates the last record with one too (verified against git
 * 2.39). Splitting on newlines would return a single malformed record, so the
 * fields are read in fixed-size groups instead.
 */
export function parseStashes(stdout: string): StashEntry[] {
  const chunks = stdout.split('\u0000');
  // Drop the trailing empty chunk left by the final terminator.
  if (chunks.length > 0 && chunks[chunks.length - 1] === '') chunks.pop();
  if (chunks.length === 0) return [];

  if (chunks.length % FIELDS_PER_STASH !== 0) {
    fail(
      `Stash output has ${chunks.length} fields, not a multiple of ${FIELDS_PER_STASH}`,
    );
  }

  const entries: StashEntry[] = [];
  for (let i = 0; i < chunks.length; i += FIELDS_PER_STASH) {
    const [ref, , date, message] = chunks.slice(i, i + FIELDS_PER_STASH) as [
      string,
      string,
      string,
      string,
    ];

    const index = /^stash@\{(\d+)\}$/.exec(ref);
    if (index === null) fail(`Unrecognized stash ref: ${ref.slice(0, 40)}`);

    const entry: StashEntry = { ref, index: Number(index[1]), message, date };
    // `On <branch>: <message>` is how git records where a stash was taken.
    const branch = /^(?:On|WIP on) ([^:]+):/.exec(message);
    if (branch !== null) entry.branch = branch[1];
    entries.push(entry);
  }

  return entries;
}
