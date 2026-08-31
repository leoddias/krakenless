import {
  buildHeadOidCommand,
  buildRepoProbeCommand,
  buildToplevelCommand,
  buildVersionCommand,
} from './commands/repo';
import { GitError } from './errors';
import { buildRepoInfo, parseRepoProbe, parseToplevel } from './parsers/repo';
import { parseGitVersion, unsupportedGitMessage } from './parsers/version';
import { runGit } from './runner';
import type { RepoInfo } from './types';

/**
 * Refuses a git too old to run this app's commands, before running any of them.
 *
 * First, deliberately. Git does not report an unsupported flag as a version
 * problem — `rev-parse` echoes an unknown flag to stdout and exits 0, and a
 * rejected flag value fails with a message naming a flag the user never typed.
 * Both shipped as bugs. Asking the version up front replaces that whole class
 * of confusion with one sentence, and it costs a single process that reads
 * nothing and writes nothing.
 */
async function assertSupportedGit(path: string): Promise<void> {
  const output = await runGit(path, buildVersionCommand());
  const message = unsupportedGitMessage(parseGitVersion(output.stdout));
  if (message !== null) {
    throw new GitError('git-missing', message, { args: ['--version'] });
  }
}

/**
 * True only for the one failure that legitimately means "this repository has
 * no commits yet". Anything else — a timeout, a missing binary, a broken
 * repository — must not be quietly turned into `empty: true`, or the UI would
 * offer "create the initial commit" for a repo full of history.
 */
function meansNoCommitsYet(error: unknown): boolean {
  if (!(error instanceof GitError)) return false;
  if (error.kind !== 'command-failed') return false;
  return /(unknown revision|ambiguous argument 'HEAD'|needed a single revision)/i.test(
    error.stderr,
  );
}

/**
 * Identifies the repository containing `path`. Throws a typed
 * {@link GitError} (`not-a-repository`, `git-missing`, `timeout`) rather than
 * returning a half-filled object, so the UI can say something true.
 */
export async function openRepository(path: string): Promise<RepoInfo> {
  await assertSupportedGit(path);

  const probe = await runGit(path, buildRepoProbeCommand());
  const { gitDir, bare } = parseRepoProbe(probe.stdout);

  // `--show-toplevel` fails in a bare repository; there the git dir *is* the
  // repository, so don't ask.
  const root = bare
    ? gitDir
    : parseToplevel((await runGit(path, buildToplevelCommand())).stdout);

  let empty = false;
  try {
    // Exit code 1 with empty output is how `--verify --quiet` reports "no HEAD".
    const head = await runGit(path, buildHeadOidCommand(), { allowExitCodes: [1] });
    empty = head.stdout.trim().length === 0;
  } catch (error) {
    if (!meansNoCommitsYet(error)) throw error;
    empty = true;
  }

  return buildRepoInfo({ root, gitDir, bare, empty });
}
