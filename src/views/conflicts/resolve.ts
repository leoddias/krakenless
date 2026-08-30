/**
 * Turning two versions of a file into one, block by block.
 *
 * The model is deliberately small and pure, because it decides what ends up on
 * somebody's disk. A resolution is a list of **blocks**: runs of lines the two
 * sides agree on, which are simply kept, and runs where they disagree, where
 * the user picks ours, theirs, both, or neither. The final file is those
 * choices concatenated — so the preview the user reads is not an approximation
 * of the result, it *is* the result, produced by the same function that writes.
 *
 * The diff is a plain longest-common-subsequence over lines. Not because it is
 * clever, but because it is predictable: a user comparing two panes must be
 * able to see why a block is a block, and a heuristic that occasionally aligns
 * lines "better" is a heuristic that occasionally aligns them worse with no
 * way to tell.
 */

/** Which side of a disagreement to keep. `both` keeps ours then theirs. */
export type Choice = 'ours' | 'theirs' | 'both' | 'neither';

export interface AgreedBlock {
  kind: 'same';
  lines: string[];
}

export interface ConflictBlock {
  kind: 'conflict';
  /** Stable across re-renders; the index of the block in the file. */
  id: number;
  ours: string[];
  theirs: string[];
  /** What the user picked. Starts unset, which is what makes them choose. */
  choice: Choice | null;
}

export type Block = AgreedBlock | ConflictBlock;

/** Splits into lines, remembering whether the text ended with a newline. */
export function toLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  // A trailing newline produces a final empty element that is not a line; a
  // file with no trailing newline does not. Dropping it here and adding it back
  // in `assemble` is what keeps a round trip byte-identical.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Lengths of the longest common subsequence for every prefix pair.
 *
 * Quadratic in lines, which is the honest cost of an exact answer. Guarded by
 * {@link MAX_LINES} at the call site rather than swapped for something
 * approximate: a file too big for this deserves the merge tool, not a worse
 * diff presented as the same thing.
 */
function lcsTable(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const row = table[i];
      const next = table[i + 1];
      if (row === undefined || next === undefined) continue;
      row[j] =
        a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  return table;
}

/**
 * Above this many lines on a side, the pane refuses rather than freezing.
 *
 * The table above is `ours × theirs` numbers; at ten thousand lines a side that
 * is a hundred million cells, which is a hung window, not a slow one.
 */
export const MAX_LINES = 4000;

/** True when a file is too large for the block view to build honestly. */
export function tooLargeToCompare(ours: string, theirs: string): boolean {
  return toLines(ours).length > MAX_LINES || toLines(theirs).length > MAX_LINES;
}

/**
 * Builds the block list for two versions of a file.
 *
 * Runs of identical lines become `same` blocks; everything between them becomes
 * one `conflict` block with each side's lines. A block where one side is empty
 * is a pure insertion or deletion, and is still a choice — "they added this"
 * deserves the same yes/no as "we both changed this".
 */
export function buildBlocks(ours: string[], theirs: string[]): Block[] {
  const table = lcsTable(ours, theirs);
  const blocks: Block[] = [];
  let i = 0;
  let j = 0;
  let nextId = 0;

  const matching = (): boolean =>
    i < ours.length && j < theirs.length && ours[i] === theirs[j];

  while (i < ours.length || j < theirs.length) {
    if (matching()) {
      const run: string[] = [];
      while (matching()) {
        run.push(ours[i] as string);
        i += 1;
        j += 1;
      }
      blocks.push({ kind: 'same', lines: run });
      continue;
    }

    // Everything up to the next agreed line is *one* decision, both sides
    // together. Emitting a block per side would ask the user twice about a
    // single edit and would lose the pairing that makes the two panes readable.
    const ourRun: string[] = [];
    const theirRun: string[] = [];
    while ((i < ours.length || j < theirs.length) && !matching()) {
      if (j >= theirs.length) {
        ourRun.push(ours[i] as string);
        i += 1;
      } else if (i >= ours.length) {
        theirRun.push(theirs[j] as string);
        j += 1;
      } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
        // Walking down whichever side keeps more in common afterwards is what
        // makes the agreed runs as long as they can be.
        ourRun.push(ours[i] as string);
        i += 1;
      } else {
        theirRun.push(theirs[j] as string);
        j += 1;
      }
    }

    if (ourRun.length > 0 || theirRun.length > 0) {
      blocks.push({
        kind: 'conflict',
        id: nextId++,
        ours: ourRun,
        theirs: theirRun,
        choice: null,
      });
    }
  }

  return blocks;
}

/** Applies a choice to one block. Returns a new list; nothing is mutated. */
export function choose(blocks: Block[], id: number, choice: Choice): Block[] {
  return blocks.map((block) =>
    block.kind === 'conflict' && block.id === id ? { ...block, choice } : block,
  );
}

/** Applies one choice to every unresolved block — the "take all mine" button. */
export function chooseAll(blocks: Block[], choice: Choice): Block[] {
  return blocks.map((block) =>
    block.kind === 'conflict' ? { ...block, choice } : block,
  );
}

/** Blocks still waiting on a decision. */
export function undecided(blocks: Block[]): ConflictBlock[] {
  return blocks.filter(
    (block): block is ConflictBlock => block.kind === 'conflict' && block.choice === null,
  );
}

/** How many decisions there are in total. */
export function conflictCount(blocks: Block[]): number {
  return blocks.filter((block) => block.kind === 'conflict').length;
}

/**
 * The resolved file, as lines.
 *
 * An undecided block contributes **nothing**, which is what makes the preview
 * honest: a half-answered resolution visibly has a hole in it, rather than
 * quietly defaulting to one side and looking finished.
 */
export function assembleLines(blocks: Block[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'same') {
      out.push(...block.lines);
      continue;
    }
    switch (block.choice) {
      case 'ours':
        out.push(...block.ours);
        break;
      case 'theirs':
        out.push(...block.theirs);
        break;
      case 'both':
        out.push(...block.ours, ...block.theirs);
        break;
      case 'neither':
      case null:
        break;
    }
  }
  return out;
}

/**
 * The resolved file, as the text to write.
 *
 * `trailingNewline` is carried from the original rather than assumed: adding
 * one to a file that never had it, or dropping one that was there, is a diff
 * the user did not ask for on a line they never touched.
 */
export function assemble(blocks: Block[], trailingNewline: boolean): string {
  const lines = assembleLines(blocks);
  if (lines.length === 0) return '';
  return lines.join('\n') + (trailingNewline ? '\n' : '');
}

/** Whether the original text ended with a newline. */
export function endsWithNewline(text: string): boolean {
  return text.length > 0 && text.endsWith('\n');
}
