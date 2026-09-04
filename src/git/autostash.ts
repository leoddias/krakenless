/**
 * Recognising an autostash git could not put back.
 *
 * `--autostash` on a rebase or a pull puts uncommitted work aside and brings
 * it back afterwards. When bringing it back conflicts, git says so — on stderr
 * — keeps the entry, and still exits **0**. Nothing else distinguishes that
 * from a clean run at the moment it happens, and a status read afterwards
 * cannot tell these conflict markers from ones that were already there. So
 * the words are matched, here, once, for every command that carries the flag.
 *
 * Two sentences, because git changed its mind about this one. Newer versions
 * say "Applying autostash resulted in conflicts."; older ones say "Your local
 * changes are stashed, however applying them resulted in conflicts." — wrapped
 * across lines, which is why whitespace is collapsed before the match. The
 * second wording is what GitHub's Windows runner produced, and matching only
 * the first is a warning that never fires on the git half the world is running.
 */
const AUTOSTASH_CONFLICT = /applying (?:autostash|them) resulted in conflicts/i;

/**
 * True when git reported that it could not put the autostash back.
 *
 * Exported so the integration tests can assert against the real binary's
 * output instead of a string this file also owns — a test that repeated the
 * regex would pass on a git whose wording this function does not recognise.
 */
export function autostashConflicted(output: string): boolean {
  return AUTOSTASH_CONFLICT.test(output.replace(/\s+/g, ' '));
}

/** Both streams, joined: git reports this on stderr while exiting 0. */
export function autostashConflictedIn(output: {
  stdout: string;
  stderr: string;
}): boolean {
  return autostashConflicted(`${output.stdout}\n${output.stderr}`);
}

/**
 * What the user is told when it happened. One sentence for every command
 * that can end this way, so a pull and a rebase do not describe the same
 * stash two different ways.
 */
export function autostashConflictMessage(whatSucceeded: string): string {
  return `${whatSucceeded}, but your stashed changes did not come back cleanly: the working tree has conflict markers and the changes are still in the stash git named "autostash". Resolve the files, then drop that stash — or reset them and pop it again.`;
}
