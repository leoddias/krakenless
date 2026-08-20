import {
  buildHeadOidCommand,
  buildRepoProbeCommand,
  buildToplevelCommand,
} from './commands/repo';
import { GitError } from './errors';
import { buildRepoInfo, parseRepoProbe, parseToplevel } from './parsers/repo';
import { runGit } from './runner';
import type { RepoInfo } from './types';

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
