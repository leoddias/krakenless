import { assertRevision } from '../argsafety';
import { GitError } from '../errors';
import type { GitCommand } from '../types';

/**
 * Field separator: ASCII US (0x1f). Record separator: ASCII RS (0x1e).
 *
 * Commit subjects and bodies are arbitrary user text: a newline, a tab, a
 * comma or a `|` all appear in real messages, so none of them can delimit
 * fields. The two ASCII "separator" control characters are the closest thing
 * git offers to a byte that never occurs — but "never" is not "cannot": git
 * stores the message bytes verbatim, and a commit *can* carry a 0x1f or 0x1e
 * (verified with git 2.39). The layout below is therefore built so that any
 * such collision changes the field count of a record instead of silently
 * shifting values into the wrong fields, and {@link parseLog} rejects it.
 */
export const LOG_FIELD_SEPARATOR = '\u001f';
export const LOG_RECORD_SEPARATOR = '\u001e';

/**
 * Placeholders, in order. The free-text fields (`%s`, `%b`) come last so that
 * a separator smuggled inside them adds fields at the end rather than
 * corrupting the oid or dates ahead of them.
 *
 * `%D` needs `--decorate=full` to be unambiguous: in short form a tag and a
 * branch called `v1.0` decorate identically.
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

/** How many fields {@link parseLog} must find in every record. */
export const LOG_FIELD_COUNT = LOG_FIELDS.length;

/**
 * The record separator is a *prefix*, not a terminator: git appends a newline
 * after each record, so a trailing separator would leave a stray fragment that
 * is indistinguishable from a body collision. With a prefix, well-formed
 * output always starts with RS and every chunk after a split is a record.
 */
export const LOG_FORMAT = `%x1e${LOG_FIELDS.join('%x1f')}`;

export interface LogOptions {
  /** Maximum number of commits to return. Must be >= 1. */
  limit?: number;
  /** Commits to skip before the first returned one. Must be >= 0. */
  skip?: number;
  /** Walk every ref (`--all`) instead of just HEAD. */
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
 * - the trailing `--`: it ends the revision list, so a revision is never
 *   reinterpreted as a path (nor a path as a revision).
 *
 * The runner already prepends `--no-pager -c core.quotePath=false`.
 */
export function buildLogCommand(options: LogOptions = {}): GitCommand {
  const args = [
    'log',
    '--no-color',
    '--no-show-signature',
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
