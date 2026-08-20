import type { GitErrorKind, GitOutput } from './types';

/** Anything the git layer throws. Carries enough context for an honest UI. */
export class GitError extends Error {
  readonly kind: GitErrorKind;
  /** Arguments of the failing command; never includes file contents. */
  readonly args: string[];
  readonly code: number | null;
  readonly stderr: string;

  constructor(
    kind: GitErrorKind,
    message: string,
    options: { args?: string[]; code?: number | null; stderr?: string } = {},
  ) {
    super(message);
    this.name = 'GitError';
    this.kind = kind;
    this.args = options.args ?? [];
    this.code = options.code ?? null;
    this.stderr = options.stderr ?? '';
  }
}

/**
 * Patterns are anchored to phrasings git actually emits. A bare substring
 * (`'conflict'`) would also match a branch or path named after it and send the
 * UI down the wrong recovery path.
 */
const NOT_A_REPOSITORY = /fatal: not a git repository/i;

const AUTHENTICATION = [
  /fatal: authentication failed/i,
  /could not read (username|password) for/i,
  /permission denied \(publickey/i,
  /terminal prompts disabled/i,
  /invalid username or (password|token)/i,
];

const CONFLICT = [
  /^CONFLICT \(/m,
  /automatic merge failed/i,
  /you have unmerged files/i,
  /needs merge/i,
  /error: could not apply /i,
  /fix conflicts and (then )?run/i,
];

/**
 * Classifies a failed git invocation from its stderr. Pure so it can be tested
 * against real stderr samples without spawning git.
 */
export function classifyFailure(args: string[], output: GitOutput): GitError {
  const stderr = output.stderr.trim();
  const context = { args, code: output.code, stderr };
  // Some commands announce conflicts on *stdout* — `git stash pop` and
  // `git merge` both print `CONFLICT (content): …` there. Classifying from
  // stderr alone reports those as an anonymous "git failed with code 1".
  const announced = `${stderr}\n${output.stdout.trim()}`;

  if (output.timedOut) {
    return new GitError('timeout', `git ${args[0] ?? ''} timed out`.trim(), context);
  }
  if (NOT_A_REPOSITORY.test(stderr)) {
    return new GitError('not-a-repository', 'Not a git repository', context);
  }
  if (AUTHENTICATION.some((pattern) => pattern.test(stderr))) {
    return new GitError('authentication', 'Authentication failed', context);
  }
  if (CONFLICT.some((pattern) => pattern.test(announced))) {
    return new GitError('conflict', 'Conflicts must be resolved first', context);
  }

  const firstLine = stderr.split('\n')[0] ?? '';
  return new GitError(
    'command-failed',
    firstLine || `git failed with code ${output.code}`,
    context,
  );
}
