/**
 * Wording for the welcome screen. Kept pure and separate from the component so
 * every message can be asserted directly, and so a new error kind is a data
 * change rather than a JSX change.
 *
 * Rule: never a generic "something went wrong". Each failure says what happened
 * and, when there is one, what the user can do about it.
 */

export interface RepoErrorMessage {
  /** Short, plain-language statement of what failed. */
  title: string;
  /** What to do next; the caller renders it under the title. */
  hint: string;
  /** Whether offering the folder picker again could plausibly help. */
  canPickAnother: boolean;
}

/**
 * Maps a repository failure onto user-facing wording. `kind` comes from
 * `GitError.kind`; `message` is git's own explanation and is shown as detail by
 * the caller, so unknown kinds still say something true.
 */
export function repoErrorMessage(kind: string | undefined): RepoErrorMessage {
  switch (kind) {
    case 'git-missing':
      return {
        title: 'Git is not installed, or it is not on your PATH.',
        hint: 'Install git, then restart Krakenless so it can find the binary.',
        canPickAnother: false,
      };
    case 'not-a-repository':
      return {
        title: 'That folder is not a git repository.',
        hint: 'Pick a folder that contains a .git directory, or one inside it.',
        canPickAnother: true,
      };
    case 'bad-repo-path':
      return {
        title: 'That folder could not be read.',
        hint: 'It may have been moved, renamed or deleted since it was opened.',
        canPickAnother: true,
      };
    case 'timeout':
      return {
        title: 'Git took too long to answer and the command was stopped.',
        hint: 'Very large repositories can need a second try.',
        canPickAnother: true,
      };
    default:
      return {
        title: 'Git could not open this repository.',
        hint: 'The details below come straight from git.',
        canPickAnother: true,
      };
  }
}

/** Last path segment of a repository root, for the primary label of a row. */
export function repoName(path: string): string {
  const segments = path.split(/[\\/]+/).filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? path;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Human wording for "last opened". Takes `now` explicitly so the result is
 * deterministic in tests and so the clock is never read during render.
 */
export function formatLastOpened(iso: string, now: Date): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 'Last opened: unknown';

  const elapsed = now.getTime() - then.getTime();
  if (elapsed < 0) return 'Opened just now';

  const days = Math.floor(elapsed / DAY_MS);
  if (days === 0) return 'Opened today';
  if (days === 1) return 'Opened yesterday';
  if (days < 30) return `Opened ${days} days ago`;
  return `Opened on ${then.toISOString().slice(0, 10)}`;
}
