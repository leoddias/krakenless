/**
 * Turning three versions of a file into one, block by block.
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
 *
 * **The common ancestor is read, not ignored.** Comparing only ours against
 * theirs cannot tell "they changed this" from "we both changed it": both look
 * like two different runs of text. Against the base it is obvious, and a run
 * only one side touched is not a question — it is that side's edit, and
 * {@link buildMergedBlocks} answers it (`auto`) instead of making somebody tick
 * a box beside the words "nothing on this side". Only the runs both sides
 * genuinely changed are left undecided, which is what git means by a conflict.
 */

/** Which side of a disagreement to keep. `both` keeps ours then theirs. */
export type Choice = 'ours' | 'theirs' | 'both' | 'neither';

export interface AgreedBlock {
  kind: 'same';
  lines: string[];
  /** True once these lines have been hand-edited in the Output pane. */
  edited?: true;
}

export interface ConflictBlock {
  kind: 'conflict';
  /** Stable across re-renders; the index of the block in the file. */
  id: number;
  ours: string[];
  theirs: string[];
  /** What the user picked. Starts unset, which is what makes them choose. */
  choice: Choice | null;
  /**
   * True when the choice above was made by the three-way merge rather than by a
   * person: only one side moved away from the common ancestor, so the other has
   * nothing to say about it. Still a block, still ticked, still tickable the
   * other way — the user may disagree — but not what Previous/Next hunts for.
   */
  auto?: true;
  /** True once either side's lines have been hand-edited in the Output pane. */
  edited?: true;
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

/** Two runs of lines, identical. */
function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index]);
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
 * The tables are `base × ours` and `base × theirs` numbers; at ten thousand
 * lines a side that is a hundred million cells, which is a hung window, not a
 * slow one.
 */
export const MAX_LINES = 4000;

/** True when a file is too large for the block view to build honestly. */
export function tooLargeToCompare(ours: string, theirs: string, base = ''): boolean {
  return (
    toLines(ours).length > MAX_LINES ||
    toLines(theirs).length > MAX_LINES ||
    toLines(base).length > MAX_LINES
  );
}

/**
 * Builds the block list for two versions of a file, with no ancestor to judge
 * them against.
 *
 * Runs of identical lines become `same` blocks; everything between them becomes
 * one `conflict` block with each side's lines, and every one of them is a
 * question, because without the base there is no telling whose edit it was.
 * That is the add/add case — both sides created the file — and the fallback
 * when stage 1 is missing.
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

/**
 * For every line of `a`, the line of `b` it is matched to, or -1.
 *
 * The matching is the longest common subsequence, walked greedily, so it is
 * monotonic: later lines of `a` never match earlier lines of `b`. That property
 * is what lets {@link buildMergedBlocks} treat a base line matched on both
 * sides as a point all three files pass through together.
 */
function alignment(a: string[], b: string[]): number[] {
  const table = lcsTable(a, b);
  const map = new Array<number>(a.length).fill(-1);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      map[i] = j;
      i += 1;
      j += 1;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return map;
}

/**
 * Builds the block list from all three stages — the real merge.
 *
 * Each side is aligned to the common ancestor. A base line both sides kept is
 * an *anchor*, and a run of consecutive anchors is text all three files agree
 * on, which becomes a `same` block. Between anchors sits one change, with the
 * three versions of it in hand, and that is where the question is answered:
 *
 * - only theirs moved → the block is taken from theirs, `auto`;
 * - only ours moved → taken from ours, `auto`;
 * - both made the *same* change → taken from ours, `auto` (the two runs are
 *   identical, so which name it wears does not change a byte);
 * - both moved, differently → `choice: null`, the one case a person must read.
 *
 * `auto` blocks are drawn, ticked and tickable the other way: the merge is
 * shown rather than hidden, because a resolution nobody can see is one nobody
 * can disagree with.
 */
export function buildMergedBlocks(
  base: string[],
  ours: string[],
  theirs: string[],
): Block[] {
  const toOurs = alignment(base, ours);
  const toTheirs = alignment(base, theirs);
  const blocks: Block[] = [];
  let nextId = 0;

  /** Agreed text is one block however many anchors it was found in. */
  const keep = (lines: string[]): void => {
    if (lines.length === 0) return;
    const last = blocks[blocks.length - 1];
    if (last?.kind === 'same') {
      last.lines.push(...lines);
      return;
    }
    blocks.push({ kind: 'same', lines });
  };

  const change = (baseRun: string[], ourRun: string[], theirRun: string[]): void => {
    if (ourRun.length === 0 && theirRun.length === 0) {
      // Both sides deleted the same lines. Nothing to keep, nothing to ask.
      return;
    }
    if (sameLines(ourRun, theirRun)) {
      // Both sides agree on what this text should be now. If that is what the
      // ancestor already said, it is not even a change.
      if (sameLines(ourRun, baseRun)) {
        keep(ourRun);
        return;
      }
      blocks.push({
        kind: 'conflict',
        id: nextId++,
        ours: ourRun,
        theirs: theirRun,
        choice: 'ours',
        auto: true,
      });
      return;
    }
    const oursMoved = !sameLines(ourRun, baseRun);
    const theirsMoved = !sameLines(theirRun, baseRun);
    if (oursMoved && theirsMoved) {
      blocks.push({
        kind: 'conflict',
        id: nextId++,
        ours: ourRun,
        theirs: theirRun,
        choice: null,
      });
      return;
    }
    blocks.push({
      kind: 'conflict',
      id: nextId++,
      ours: ourRun,
      theirs: theirRun,
      choice: oursMoved ? 'ours' : 'theirs',
      auto: true,
    });
  };

  let b = 0;
  let o = 0;
  let t = 0;
  for (;;) {
    let anchor = b;
    while (anchor < base.length && (toOurs[anchor] === -1 || toTheirs[anchor] === -1)) {
      anchor += 1;
    }
    if (anchor >= base.length) {
      // Past the last anchor: whatever is left of each file is one change.
      change(base.slice(b), ours.slice(o), theirs.slice(t));
      break;
    }
    const anchorOurs = toOurs[anchor] as number;
    const anchorTheirs = toTheirs[anchor] as number;
    change(
      base.slice(b, anchor),
      ours.slice(o, anchorOurs),
      theirs.slice(t, anchorTheirs),
    );

    // As many anchors in a row as stay lock-step in all three files.
    let end = anchor;
    while (
      end < base.length &&
      toOurs[end] === anchorOurs + (end - anchor) &&
      toTheirs[end] === anchorTheirs + (end - anchor)
    ) {
      end += 1;
    }
    keep(base.slice(anchor, end));
    b = end;
    o = anchorOurs + (end - anchor);
    t = anchorTheirs + (end - anchor);
  }

  return blocks;
}

/** Applies a choice to one block. Returns a new list; nothing is mutated. */
export function choose(blocks: Block[], id: number, choice: Choice): Block[] {
  return blocks.map((block) =>
    block.kind === 'conflict' && block.id === id ? { ...block, choice } : block,
  );
}

/** Applies one choice to every block — the "take all mine" button. */
export function chooseAll(blocks: Block[], choice: Choice): Block[] {
  return blocks.map((block) =>
    block.kind === 'conflict' ? { ...block, choice } : block,
  );
}

/** Which run of a block a stretch of output came from. */
export type BlockPart = 'lines' | 'ours' | 'theirs';

/**
 * Replaces one run of lines with text a person typed.
 *
 * The edit is written back into the block it came from rather than kept beside
 * the model, so {@link assemble} stays the only thing that builds the file and
 * the Output pane stays the file rather than a second opinion about it. The
 * block is flagged `edited`, because the panes above claim to show what each
 * side had, and after this they show what the user made of it.
 */
export function editLines(
  blocks: Block[],
  index: number,
  part: BlockPart,
  lines: string[],
): Block[] {
  return blocks.map((block, at) => {
    if (at !== index) return block;
    if (block.kind === 'same') {
      return part === 'lines' ? { ...block, lines, edited: true as const } : block;
    }
    if (part === 'ours') return { ...block, ours: lines, edited: true as const };
    if (part === 'theirs') return { ...block, theirs: lines, edited: true as const };
    return block;
  });
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

/** How many of them the three-way merge answered without asking. */
export function autoCount(blocks: Block[]): number {
  return blocks.filter((block) => block.kind === 'conflict' && block.auto === true)
    .length;
}

/**
 * The blocks Previous and Next walk: the ones a person is meant to read.
 *
 * A block the merge decided is skipped — stepping through forty automatic
 * decisions to reach the two real ones is the job this navigation exists to
 * remove — unless the user has unticked it back to undecided, in which case it
 * is blocking Save and has to be reachable.
 */
export function navigable(blocks: Block[]): ConflictBlock[] {
  return blocks.filter(
    (block): block is ConflictBlock =>
      block.kind === 'conflict' && (block.auto !== true || block.choice === null),
  );
}

/** A run of output lines and where they came from. */
export interface OutputSegment {
  /** `same` for lines both sides already agreed on. */
  origin: 'same' | 'ours' | 'theirs';
  lines: string[];
  /** The block the run was decided by; absent for agreed lines. */
  blockId?: number;
  /** Where the block sits in the list, so an edit can be written back to it. */
  blockIndex: number;
  /** Which run of that block this is. */
  part: BlockPart;
  /** True when these lines have been hand-edited. */
  edited?: true;
}

/**
 * The resolved file, in runs that remember which side each one came from.
 *
 * This is the *only* place the result is assembled — {@link assembleLines} and
 * therefore {@link assemble} are this function flattened. That matters: the
 * Output pane colours these runs to show what a decision actually changed, and
 * a second walk over the blocks to produce the colours would be an
 * approximation of the file rather than the file. The same runs are what a user
 * edits: each one carries the address of the lines it came from.
 *
 * An undecided block contributes **nothing**, which is what makes the preview
 * honest: a half-answered resolution visibly has a hole in it, rather than
 * quietly defaulting to one side and looking finished. `both` produces two
 * runs, ours then theirs, because they are two different origins even though
 * they are one decision.
 */
export function assembleSegments(blocks: Block[]): OutputSegment[] {
  const out: OutputSegment[] = [];
  const take = (
    origin: OutputSegment['origin'],
    lines: string[],
    blockIndex: number,
    part: BlockPart,
    blockId: number | undefined,
    edited: boolean,
  ): void => {
    if (lines.length === 0) return;
    out.push({
      origin,
      lines,
      blockIndex,
      part,
      ...(blockId === undefined ? {} : { blockId }),
      ...(edited ? { edited: true as const } : {}),
    });
  };

  blocks.forEach((block, index) => {
    if (block.kind === 'same') {
      take('same', block.lines, index, 'lines', undefined, block.edited === true);
      return;
    }
    const edited = block.edited === true;
    switch (block.choice) {
      case 'ours':
        take('ours', block.ours, index, 'ours', block.id, edited);
        break;
      case 'theirs':
        take('theirs', block.theirs, index, 'theirs', block.id, edited);
        break;
      case 'both':
        take('ours', block.ours, index, 'ours', block.id, edited);
        take('theirs', block.theirs, index, 'theirs', block.id, edited);
        break;
      case 'neither':
      case null:
        break;
    }
  });
  return out;
}

/**
 * The resolved file, as lines. {@link assembleSegments}, flattened.
 */
export function assembleLines(blocks: Block[]): string[] {
  return assembleSegments(blocks).flatMap((segment) => segment.lines);
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
