/**
 * Independent check for operations that can destroy work.
 *
 * The `destructive` flag on a {@link GitCommand} is set by builders, and a
 * builder can forget it. This deny-list is derived from the arguments
 * themselves, so the safety gate holds even when the flag is missing — one
 * mechanical chokepoint instead of trust in every future builder.
 */

function hasFlag(args: string[], ...flags: string[]): boolean {
  return args.some((arg) => flags.includes(arg));
}

/**
 * Global options that consume the following token. Missing one here would make
 * its *value* look like the subcommand — `--git-dir /x/.git reset --hard`
 * would parse as the subcommand `/x/.git` and slip through the gate.
 */
const VALUE_TAKING_GLOBALS = new Set([
  '-c',
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
  '--super-prefix',
  '--attr-source',
]);

/** Subcommands known to be read-only; anything unrecognized fails closed. */
const READ_ONLY = new Set([
  'status',
  'log',
  'show',
  'diff',
  'diff-tree',
  'diff-index',
  'rev-parse',
  'rev-list',
  'ls-files',
  'ls-tree',
  'ls-remote',
  'cat-file',
  'for-each-ref',
  'show-ref',
  'name-rev',
  'describe',
  'blame',
  'shortlog',
  'count-objects',
  'var',
  'version',
  'help',
  'check-ref-format',
  'check-ignore',
  'hash-object',
  'symbolic-ref',
  'merge-base',
]);

/** Subcommands that write but cannot destroy existing work. */
const SAFE_WRITES = new Set([
  'add',
  'commit',
  'fetch',
  'remote',
  'init',
  'clone',
  'config',
  'notes',
  'bundle',
  'archive',
  'mv',
]);

/** Index of the subcommand, skipping leading global options. */
function subcommandIndex(args: string[]): number {
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) return -1;
    if (VALUE_TAKING_GLOBALS.has(arg)) {
      i += 2;
      continue;
    }
    if (arg.startsWith('-')) {
      i += 1;
      continue;
    }
    return i;
  }
  return -1;
}

/**
 * True when running these arguments could lose committed or uncommitted work.
 * Deliberately over-inclusive: a false positive costs one confirmation, a
 * false negative costs the user's work.
 */
export function isDestructive(args: string[]): boolean {
  const index = subcommandIndex(args);
  if (index < 0) return false;
  const subcommand = args[index];
  const rest = args.slice(index + 1);

  switch (subcommand) {
    case 'reset':
      return hasFlag(rest, '--hard', '--merge', '--keep');
    case 'checkout':
    case 'restore':
      // `checkout -- <path>` and `restore` overwrite working-tree changes.
      // `restore --staged` alone only touches the index, but the worktree
      // variants share the subcommand, so require confirmation for both.
      return true;
    case 'clean':
      return true;
    case 'branch':
      return hasFlag(rest, '-D', '-d', '--delete', '--force', '-M');
    case 'tag':
      return hasFlag(rest, '-d', '--delete', '-f', '--force');
    case 'push':
      return (
        hasFlag(rest, '-f', '--force', '--delete', '--prune', '--mirror') ||
        rest.some((arg) => arg.startsWith('--force')) ||
        // A leading `+` in a refspec is a force push in disguise.
        rest.some((arg) => /^\+[^-]/.test(arg))
      );
    case 'stash':
      // Bare `git stash` means `push`, which moves the working tree aside.
      // Recoverable, but the user must have asked for it.
      return rest.length === 0 || hasFlag(rest, 'drop', 'clear', 'pop', 'push');
    case 'rebase':
    case 'filter-branch':
    case 'gc':
    case 'prune':
      return true;
    case 'merge':
      return hasFlag(rest, '--abort', '--reset');
    case 'am':
    case 'cherry-pick':
    case 'revert':
      return hasFlag(rest, '--abort', '--quit');
    case 'update-ref':
      return hasFlag(rest, '-d', '--stdin');
    case 'reflog':
      return hasFlag(rest, 'delete', 'expire');
    case 'worktree':
      return hasFlag(rest, 'remove', 'prune');
    case 'submodule':
      return hasFlag(rest, 'deinit');
    case 'switch':
      return hasFlag(rest, '-f', '--force', '--discard-changes', '-C', '--force-create');
    case 'rm':
      // `--cached` only unstages; anything else deletes files from disk.
      return !hasFlag(rest, '--cached');
    case 'apply':
      // Reverse-applying to the worktree is how a hunk gets discarded.
      return hasFlag(rest, '-R', '--reverse') && !hasFlag(rest, '--cached');
    case 'read-tree':
      return hasFlag(rest, '--reset', '-u');
    case 'checkout-index':
    case 'sparse-checkout':
    case 'replace':
    case 'repack':
      return true;
    default:
      // Fail closed: an unknown subcommand, or a shape this function could not
      // parse, is treated as destructive rather than waved through.
      return !READ_ONLY.has(subcommand ?? '') && !SAFE_WRITES.has(subcommand ?? '');
  }
}
