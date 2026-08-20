import { assertRefName, assertRevision } from '../argsafety';
import type { GitCommand } from '../types';

/**
 * Field separator for `for-each-ref`. `%00` is a NUL, which cannot appear in a
 * ref name (git-check-ref-format forbids control characters), so no branch name
 * can forge a record boundary.
 */
export const BRANCH_FORMAT = [
  // Full refname first: a *local* branch may legally be called `feature/x`, so
  // the short name cannot tell local from remote — only the `refs/remotes/`
  // prefix can.
  '%(refname)',
  '%(refname:short)',
  '%(objectname)',
  '%(HEAD)',
  '%(upstream:short)',
  '%(upstream:track)',
].join('%00');

/** Lists local branches (and remote ones when asked) in a parseable format. */
export function buildBranchListCommand(
  options: { includeRemotes?: boolean } = {},
): GitCommand {
  const patterns =
    options.includeRemotes === true ? ['refs/heads', 'refs/remotes'] : ['refs/heads'];
  return { args: ['for-each-ref', `--format=${BRANCH_FORMAT}`, ...patterns] };
}

/** Creates a branch without switching to it. */
export function buildCreateBranchCommand(name: string, startPoint?: string): GitCommand {
  const args = ['branch', assertRefName(name)];
  if (startPoint !== undefined) args.push(assertRevision(startPoint));
  return { args };
}

/**
 * Switches branches. `switch` refuses by default when the working tree would be
 * clobbered, which is exactly the behavior we want: the app never silently
 * discards edits to change branch.
 */
export function buildSwitchCommand(name: string): GitCommand {
  return { args: ['switch', assertRefName(name)] };
}

/** Creates and switches in one step. */
export function buildSwitchNewCommand(name: string, startPoint?: string): GitCommand {
  const args = ['switch', '--create', assertRefName(name)];
  if (startPoint !== undefined) args.push(assertRevision(startPoint));
  return { args };
}

/**
 * Deletes a branch. `force` maps to `-D`, which drops unmerged commits — the
 * caller must have asked for it explicitly after the safe `-d` refused.
 */
export function buildDeleteBranchCommand(
  name: string,
  options: { force: boolean },
): GitCommand {
  return {
    args: ['branch', options.force ? '-D' : '-d', assertRefName(name)],
    destructive: true,
  };
}

/** Checks out a commit directly, leaving HEAD detached. */
export function buildCheckoutRevisionCommand(rev: string): GitCommand {
  return { args: ['switch', '--detach', assertRevision(rev)] };
}
