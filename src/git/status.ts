import { buildStatusCommand, type StatusOptions } from './commands/status';
import { parseStatus } from './parsers/status';
import { runGit } from './runner';
import type { RepoStatus } from './types';

export type { StatusOptions } from './commands/status';

/**
 * Current state of the worktree and of HEAD relative to its upstream.
 *
 * Thin by design: build, run, parse. The parsing lives in a pure function so
 * it can be tested against recorded git output without spawning anything.
 *
 * `allowLossyOutput` is deliberately *not* passed — status output is parsed
 * into paths that later reach write commands, and a lossily decoded path
 * points at a file the user never selected.
 */
export async function getStatus(
  repo: string,
  options: StatusOptions = {},
): Promise<RepoStatus> {
  const output = await runGit(repo, buildStatusCommand(options));
  return parseStatus(output.stdout);
}
