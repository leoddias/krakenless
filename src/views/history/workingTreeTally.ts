/**
 * How much is uncommitted, in three numbers.
 *
 * The working-tree row used to say only "Uncommitted changes", which is the
 * same sentence whether one line moved or four hundred files did. These are the
 * counts that tell those apart at a glance.
 *
 * Pure and on its own because the rule that matters is **one path, one
 * bucket**. A file has two states — what the index says and what the disk says
 * — and adding them up separately would report a single edited file as two
 * changes, which is the kind of number that makes people stop trusting the
 * rest of the panel.
 */

import type { FileState, RepoStatus, StatusEntry } from '../../git/types';

export interface WorkingTreeTally {
  added: number;
  modified: number;
  deleted: number;
}

/**
 * The state that decides a path's bucket.
 *
 * The working-tree side wins when it has something to say, because it is what
 * is on disk now: a file staged as added and then deleted from the tree is
 * counted as a deletion, which is what the user would see if they looked.
 */
function decisiveState(entry: StatusEntry): FileState {
  return entry.worktree === 'unmodified' ? entry.index : entry.worktree;
}

/**
 * Counts added, modified and deleted paths.
 *
 * Untracked files count as additions: git has not been told about them yet, but
 * to the person looking at the panel a new file is a new file, and leaving them
 * out would make the numbers disagree with the list right below.
 *
 * Ignored paths are not counted at all — they are not changes, they are files
 * the repository has been told to stop mentioning.
 *
 * A rename counts once, as a modification. It is one decision by one person
 * about one file; counting it as an addition *and* a deletion would double a
 * refactor's numbers for no reader's benefit.
 *
 * A conflicted path counts as modified. It is uncommitted work either way, and
 * the conflict itself is announced by the banner that owns that job.
 */
export function tallyWorkingTree(status: RepoStatus | null): WorkingTreeTally {
  const tally: WorkingTreeTally = { added: 0, modified: 0, deleted: 0 };
  if (status === null) return tally;

  for (const entry of status.entries) {
    const state = decisiveState(entry);
    if (state === 'ignored' || state === 'unmodified') continue;
    if (state === 'untracked' || state === 'added') tally.added += 1;
    else if (state === 'deleted') tally.deleted += 1;
    else tally.modified += 1;
  }
  return tally;
}

/** True when there is nothing uncommitted to show. */
export function isClean(tally: WorkingTreeTally): boolean {
  return tally.added === 0 && tally.modified === 0 && tally.deleted === 0;
}

/**
 * The counts of paths git already tracks — what a stash would actually move.
 *
 * Separate from {@link tallyWorkingTree} because the row and the stash need
 * different answers to "is there anything here". A tree holding nothing but
 * untracked files is *not* clean — the row rightly shows `+3` — but
 * `git stash push` on it prints "No local changes to save" and **exits 0**, so
 * offering the stash there produces a confirmation that promises three files
 * will move, a command that reports success, and nothing changed on disk.
 * Counting tracked paths separately is what keeps that question honest.
 */
export function tallyTracked(status: RepoStatus | null): WorkingTreeTally {
  const tally: WorkingTreeTally = { added: 0, modified: 0, deleted: 0 };
  if (status === null) return tally;

  for (const entry of status.entries) {
    const state = decisiveState(entry);
    if (state === 'ignored' || state === 'unmodified' || state === 'untracked') continue;
    if (state === 'added') tally.added += 1;
    else if (state === 'deleted') tally.deleted += 1;
    else tally.modified += 1;
  }
  return tally;
}

/**
 * The counts as the row draws them: `+15 M3 -2`.
 *
 * A zero is left out rather than printed. `+15 M0 -0` asks the reader to
 * discard two thirds of what it says, and the whole point of the line is to be
 * readable without being read.
 */
export function tallyParts(
  tally: WorkingTreeTally,
): { key: keyof WorkingTreeTally; text: string }[] {
  const parts: { key: keyof WorkingTreeTally; text: string }[] = [];
  if (tally.added > 0) parts.push({ key: 'added', text: `+${String(tally.added)}` });
  if (tally.modified > 0) {
    parts.push({ key: 'modified', text: `M${String(tally.modified)}` });
  }
  if (tally.deleted > 0) {
    parts.push({ key: 'deleted', text: `-${String(tally.deleted)}` });
  }
  return parts;
}

/** The same counts in words, for the row's accessible name and its tooltip. */
export function tallySentence(tally: WorkingTreeTally): string {
  if (isClean(tally)) return 'no uncommitted changes';
  const said: string[] = [];
  const say = (count: number, word: string): void => {
    if (count > 0) said.push(`${String(count)} ${word}`);
  };
  say(tally.added, 'added');
  say(tally.modified, 'modified');
  say(tally.deleted, 'deleted');
  return said.join(', ');
}
