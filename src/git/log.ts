import {
  buildHeadMessageCommand,
  buildLogCommand,
  type LogOptions,
} from './commands/log';
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
 *
 * Matching English text is only sound because the Rust runner spawns git with
 * `LC_ALL=C` (`src-tauri/src/git_runner.rs`). If that ever changes, this stops
 * recognizing the case and an unborn branch surfaces as an error — the safe
 * direction, never a fabricated empty history.
 */
function meansNoCommitsYet(error: unknown): boolean {
  if (!(error instanceof GitError)) return false;
  if (error.kind !== 'command-failed') return false;
  return /does not have any commits yet/i.test(error.stderr);
}

/**
 * The message of the commit at HEAD, or `null` when there is no commit yet.
 *
 * Read rather than reassembled from the loaded log: amending replaces the
 * message wholesale, so a message that came back subtly different — a body
 * separated by something other than a blank line, say — would be a rewrite the
 * user never asked for. Only the newline git prints after the format is
 * removed; everything the author typed is left alone.
 */
export async function readHeadMessage(repo: string): Promise<string | null> {
  try {
    const output = await runGit(repo, buildHeadMessageCommand());
    return output.stdout.replace(/\n+$/, '');
  } catch (error) {
    // An unborn branch has no message, which is not a failure to report: the
    // amend checkbox is already unavailable there.
    if (meansNoCommitsYet(error)) return null;
    throw error;
  }
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
