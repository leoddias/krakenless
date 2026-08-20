import { assertRevision } from '../argsafety';
import { GitError } from '../errors';
import type { GitCommand } from '../types';

/**
 * Separator between fields *and* between commits: ASCII NUL.
 *
 * Commit subjects and bodies are arbitrary user text, so no printable
 * character can delimit them. The ASCII "separator" controls (0x1e/0x1f) are
 * not enough either: git stores message bytes verbatim, and a commit really
 * can carry them (verified with git 2.39) — a crafted message could then forge
 * a whole extra record, complete with its own oid and a
 * `HEAD -> refs/heads/main` decoration. NUL is the one byte git refuses to
 * store: `git commit` answers "a NUL byte in commit log message not allowed"
 * and writes no object.
 *
 * `-z` makes git terminate every record with NUL and `%x00` separates the
 * fields, so the whole output is one flat NUL-separated stream with a fixed
 * number of fields per commit. No message content can create or move a
 * boundary; a stream whose length is not a multiple of the field count is
 * rejected rather than realigned.
 */
export const LOG_SEPARATOR = '\u0000';

/**
 * Placeholders, in order. `%D` needs `--decorate=full`: in short form a tag
 * and a branch called `v1.0` decorate identically.
 */
const LOG_FIELDS = [
  '%H', // oid
  '%h', // shortOid
  '%P', // parents, space separated, empty for a root commit
  '%an', // author name
  '%ae', // author email
  '%aI', // author date, strict ISO 8601
  '%cn', // committer name
  '%cI', // committer date, strict ISO 8601
  '%D', // ref decorations
  '%s', // subject
  '%b', // body without the subject
];

/** How many fields {@link parseLog} must find per commit. */
export const LOG_FIELD_COUNT = LOG_FIELDS.length;

export const LOG_FORMAT = LOG_FIELDS.join('%x00');

export interface LogOptions {
  /** Maximum number of commits to return. Must be >= 1. */
  limit?: number;
  /** Commits to skip before the first returned one. Must be >= 0. */
  skip?: number;
  /** Walk every ref (`--all`). Mutually exclusive with {@link LogOptions.rev}. */
  allRefs?: boolean;
  /** A single revision or a range (`main`, `HEAD~5`, `main..feature`). */
  rev?: string;
}

function assertCount(name: string, value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new GitError(
      'bad-argument',
      `log ${name} must be an integer >= ${minimum}, got ${JSON.stringify(value)}`,
      { args: ['log'] },
    );
  }
  return value;
}

/**
 * Builds the `git log` invocation the parser expects.
 *
 * Hardening that is not optional here:
 * - `--no-color`: a user's `color.ui`/`color.decorate` config must never inject
 *   ANSI escapes into the decoration field we parse.
 * - `--no-show-signature`: `log.showSignature=true` otherwise prepends gpg
 *   output to every record.
 * - `--decorate=full`: full ref paths are what makes a tag distinguishable
 *   from a branch of the same name.
 * - `--encoding=UTF-8`: with `i18n.logOutputEncoding=ISO-8859-1` in the user's
 *   config, git re-encodes the message of any commit that declares an encoding
 *   header and returns bytes that are not valid UTF-8 (verified with git
 *   2.39); the runner then rejects the whole output as undecodable and the
 *   history becomes unreadable because of one config line.
 * - the trailing `--`: it ends the revision list, so a revision is never
 *   reinterpreted as a path (nor a path as a revision).
 *
 * The runner already prepends `--no-pager -c core.quotePath=false`.
 */
export function buildLogCommand(options: LogOptions = {}): GitCommand {
  // `--all` does not narrow a revision, it *adds* every ref to the walk: asking
  // for both would answer "the history of main" with the whole repository,
  // interleaved by date. A caller has to say which one it means.
  if (options.allRefs && options.rev !== undefined) {
    throw new GitError(
      'bad-argument',
      'log takes either allRefs or a revision, not both',
      {
        args: ['log', '--all', options.rev],
      },
    );
  }

  const args = [
    'log',
    '-z',
    '--no-color',
    '--no-show-signature',
    '--encoding=UTF-8',
    '--decorate=full',
    `--format=${LOG_FORMAT}`,
  ];

  if (options.allRefs) args.push('--all');
  if (options.limit !== undefined) {
    // 0 would return nothing at all, which is far more likely an off-by-one in
    // a caller than a real request for an empty log.
    args.push(`--max-count=${assertCount('limit', options.limit, 1)}`);
  }
  if (options.skip !== undefined) {
    args.push(`--skip=${assertCount('skip', options.skip, 0)}`);
  }
  // A branch called `--all` must stay an argument, never an option.
  if (options.rev !== undefined) args.push(assertRevision(options.rev));

  args.push('--');
  return { args };
}
