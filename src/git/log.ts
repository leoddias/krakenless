import { buildLogCommand, type LogOptions } from './commands/log';
import { GitError } from './errors';
import { parseLog } from './parsers/log';
import { runGit } from './runner';
import type { Commit } from './types';

/**
 * True only for the one failure that means "this branch has no commits yet".
 *
 * `git log` exits 128 both for an unborn branch and for a revision that does
 * not exist; the messages differ (`does not have any commits yet` versus
 * `unknown revision or path not in the working tree`, verified with git 2.39).
 * Matching the narrow one keeps a typo in a ref name an error instead of a
 * silently empty history.
 */
function meansNoCommitsYet(error: unknown): boolean {
  if (!(error instanceof GitError)) return false;
  if (error.kind !== 'command-failed') return false;
  return /does not have any commits yet/i.test(error.stderr);
}

/**
 * Reads commits, newest first. Thin async layer: building and parsing stay
 * pure and unit-tested elsewhere.
 */
export async function readLog(repo: string, options: LogOptions = {}): Promise<Commit[]> {
  const command = buildLogCommand(options);
  try {
    const output = await runGit(repo, command);
    return parseLog(output.stdout);
  } catch (error) {
    // Only when the caller asked for the default walk: `readLog(repo, { rev })`
    // failing must stay a failure.
    if (options.rev === undefined && meansNoCommitsYet(error)) return [];
    throw error;
  }
}
