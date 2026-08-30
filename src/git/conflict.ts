/**
 * The three sides of a conflicted file, and the pieces a resolution is made of.
 *
 * A conflicted path is not one file, it is four: the common ancestor (stage 1),
 * ours (stage 2), theirs (stage 3), and the marked-up mess git left in the
 * working tree. The working-tree copy is the *worst* of those to build a
 * resolution UI on — the markers are ambiguous when the file legitimately
 * contains lines of angle brackets, and reading them back is guesswork. The
 * index stages are exact, so that is what this reads.
 *
 * A word on which side is which, because getting it backwards is a way to lose
 * somebody's work silently. During a **merge**, "ours" is the branch you are
 * on. During a **rebase**, git replays your commits onto the other branch, so
 * "ours" is the branch being rebased *onto* — the upstream — and "theirs" is
 * your own commit. This module does not paper over that: it reports both sides
 * with the labels the caller passes in, and the caller is responsible for
 * naming them from the operation in progress.
 */

import { buildShowStageCommand } from './commands/conflict';
import { runGit } from './runner';

/** One side of a conflict, as text plus whether the stage existed at all. */
export interface ConflictSide {
  /** The file's content on this side; empty when the side has no version. */
  text: string;
  /** False when the stage is absent — the side deleted or never added it. */
  present: boolean;
}

export interface ConflictSides {
  /** Stage 1: the common ancestor. Absent for an add/add conflict. */
  base: ConflictSide;
  /** Stage 2 — see the note above about what "ours" means in a rebase. */
  ours: ConflictSide;
  /** Stage 3. */
  theirs: ConflictSide;
}

/** Index stage numbers, in the order git assigns them. */
const STAGES = { base: 1, ours: 2, theirs: 3 } as const;

/**
 * Reads one stage. A missing stage is an answer — "this side has no version of
 * the file" is what a delete/modify conflict *is* — so it comes back as absent
 * rather than as a failure.
 */
async function readStage(
  repo: string,
  stage: 1 | 2 | 3,
  path: string,
): Promise<ConflictSide> {
  try {
    const output = await runGit(repo, buildShowStageCommand(stage, path));
    return { text: output.stdout, present: true };
  } catch {
    return { text: '', present: false };
  }
}

/** Reads all three sides of a conflicted path out of the index. */
export async function readConflictSides(
  repo: string,
  path: string,
): Promise<ConflictSides> {
  const [base, ours, theirs] = await Promise.all([
    readStage(repo, STAGES.base, path),
    readStage(repo, STAGES.ours, path),
    readStage(repo, STAGES.theirs, path),
  ]);
  return { base, ours, theirs };
}

/**
 * Whether text still carries git's conflict markers.
 *
 * Used to refuse staging a "resolution" that is really the conflict with a save
 * on top of it — the single most common way to commit a broken file. Anchored
 * to the start of a line and to git's exact seven characters, so a file that
 * discusses markers in prose is not accused of having them.
 */
export function hasConflictMarkers(text: string): boolean {
  return /^(<{7}|={7}|>{7})(\s|$)/m.test(text);
}
