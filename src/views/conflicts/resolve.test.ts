import { describe, expect, it } from 'vitest';
import {
  assemble,
  assembleLines,
  assembleSegments,
  autoCount,
  buildBlocks,
  buildMergedBlocks,
  choose,
  chooseAll,
  conflictCount,
  editLines,
  endsWithNewline,
  MAX_LINES,
  navigable,
  toLines,
  tooLargeToCompare,
  undecided,
  type Block,
} from './resolve';

/** The blocks for two files, with the conflicting ones easy to get at. */
function blocksFor(ours: string, theirs: string): Block[] {
  return buildBlocks(toLines(ours), toLines(theirs));
}

function conflicts(blocks: Block[]) {
  return blocks.filter((block) => block.kind === 'conflict');
}

describe('toLines', () => {
  it('does not invent a last empty line for a file that ends in a newline', () => {
    expect(toLines('a\nb\n')).toEqual(['a', 'b']);
    expect(toLines('a\nb')).toEqual(['a', 'b']);
    expect(toLines('')).toEqual([]);
  });

  it('keeps blank lines inside the file', () => {
    expect(toLines('a\n\nb\n')).toEqual(['a', '', 'b']);
  });
});

describe('buildBlocks', () => {
  it('keeps what both sides agree on out of the decisions', () => {
    const blocks = blocksFor('one\ntwo\nthree\n', 'one\nTWO\nthree\n');

    expect(blocks.map((block) => block.kind)).toEqual(['same', 'conflict', 'same']);
    expect(conflicts(blocks)[0]).toMatchObject({ ours: ['two'], theirs: ['TWO'] });
  });

  it('treats a pure insertion as a decision too', () => {
    // "They added this" deserves the same yes/no as "we both changed this".
    const blocks = blocksFor('one\ntwo\n', 'one\nextra\ntwo\n');
    expect(conflicts(blocks)[0]).toMatchObject({ ours: [], theirs: ['extra'] });
  });

  it('treats a deletion as a decision', () => {
    const blocks = blocksFor('one\ngone\ntwo\n', 'one\ntwo\n');
    expect(conflicts(blocks)[0]).toMatchObject({ ours: ['gone'], theirs: [] });
  });

  it('finds no decisions when the two sides are identical', () => {
    expect(conflictCount(blocksFor('same\n', 'same\n'))).toBe(0);
  });

  it('numbers the decisions so a choice can name one', () => {
    const blocks = blocksFor('a\nx\nb\ny\n', 'a\nX\nb\nY\n');
    expect(conflicts(blocks).map((block) => block.id)).toEqual([0, 1]);
  });

  it('handles one side being empty', () => {
    const blocks = blocksFor('', 'new\nfile\n');
    expect(conflicts(blocks)[0]).toMatchObject({ ours: [], theirs: ['new', 'file'] });
  });
});

describe('buildMergedBlocks', () => {
  /** The three stages, as lines. */
  function merged(base: string, ours: string, theirs: string): Block[] {
    return buildMergedBlocks(toLines(base), toLines(ours), toLines(theirs));
  }

  it('applies a change only theirs made, without asking', () => {
    // Ours never touched the line. There is no choice to offer: "keep the
    // version nobody edited" is not an answer anyone wants.
    const blocks = merged('a\nb\nc\n', 'a\nb\nc\n', 'a\nB\nc\n');
    const conflict = conflicts(blocks)[0];

    expect(conflict).toMatchObject({ ours: ['b'], theirs: ['B'], choice: 'theirs' });
    expect(conflict?.auto).toBe(true);
    expect(assembleLines(blocks)).toEqual(['a', 'B', 'c']);
    expect(undecided(blocks)).toHaveLength(0);
  });

  it('applies a change only ours made, without asking', () => {
    const blocks = merged('a\nb\nc\n', 'a\nB\nc\n', 'a\nb\nc\n');
    expect(conflicts(blocks)[0]).toMatchObject({ choice: 'ours', auto: true });
    expect(assembleLines(blocks)).toEqual(['a', 'B', 'c']);
  });

  it('leaves a line both sides changed differently undecided', () => {
    // This is the only thing git calls a conflict, and the only thing a person
    // has to read.
    const blocks = merged('a\nb\nc\n', 'a\nmine\nc\n', 'a\nyours\nc\n');
    expect(conflicts(blocks)[0]).toMatchObject({ choice: null });
    expect(conflicts(blocks)[0]?.auto).toBeUndefined();
    expect(undecided(blocks)).toHaveLength(1);
    expect(assembleLines(blocks)).toEqual(['a', 'c']);
  });

  it('keeps a change both sides made identically, once', () => {
    const blocks = merged('a\nb\nc\n', 'a\nB\nc\n', 'a\nB\nc\n');
    expect(assembleLines(blocks)).toEqual(['a', 'B', 'c']);
    expect(undecided(blocks)).toHaveLength(0);
  });

  it('applies an insertion one side made', () => {
    const blocks = merged('a\nb\n', 'a\nb\n', 'a\nnew\nb\n');
    expect(conflicts(blocks)[0]).toMatchObject({
      ours: [],
      theirs: ['new'],
      choice: 'theirs',
      auto: true,
    });
    expect(assembleLines(blocks)).toEqual(['a', 'new', 'b']);
  });

  it('applies a deletion one side made', () => {
    const blocks = merged('a\ngone\nb\n', 'a\nb\n', 'a\ngone\nb\n');
    expect(assembleLines(blocks)).toEqual(['a', 'b']);
    expect(undecided(blocks)).toHaveLength(0);
  });

  it('drops lines both sides deleted, and asks nothing', () => {
    const blocks = merged('a\ngone\nb\n', 'a\nb\n', 'a\nb\n');
    expect(assembleLines(blocks)).toEqual(['a', 'b']);
    expect(conflictCount(blocks)).toBe(0);
  });

  it('mixes automatic and real decisions in one file', () => {
    const blocks = merged(
      'a\nb1\nb\nb2\nc\nb3\nd\n',
      'a\nmine1\nb\nmine2\nc\nb3\nd\n',
      'a\nb1\nb\nyours2\nc\nb3\nd\n',
    );

    expect(conflictCount(blocks)).toBe(2);
    expect(autoCount(blocks)).toBe(1);
    // Only the block both sides moved is put to the user, and it is the only
    // one Previous/Next will stop on.
    expect(undecided(blocks)).toHaveLength(1);
    expect(navigable(blocks).map((block) => block.id)).toEqual([1]);
  });

  it('keeps the untouched text out of the decisions entirely', () => {
    const blocks = merged('a\nb\nc\n', 'a\nb\nc\n', 'a\nb\nc\n');
    expect(blocks).toEqual([{ kind: 'same', lines: ['a', 'b', 'c'] }]);
  });

  it('handles a side that deleted the whole file', () => {
    const blocks = merged('a\nb\n', '', 'a\nb\n');
    expect(assembleLines(blocks)).toEqual([]);
    expect(undecided(blocks)).toHaveLength(0);
  });

  it('asks about everything when the ancestor shares nothing with either side', () => {
    // No anchor anywhere: the whole file is one disagreement, which is the
    // truthful answer rather than a pile of invented small ones.
    const blocks = merged('x\ny\n', 'a\nb\n', 'c\nd\n');
    expect(conflictCount(blocks)).toBe(1);
    expect(undecided(blocks)).toHaveLength(1);
  });

  it('numbers its conflicts from zero, like the two-sided build', () => {
    const blocks = merged('a\nb1\nb\nb2\nc\n', 'a\nm1\nb\nm2\nc\n', 'a\ny1\nb\ny2\nc\n');
    expect(conflicts(blocks).map((block) => block.id)).toEqual([0, 1]);
  });
});

describe('navigable', () => {
  it('walks past what the merge already decided', () => {
    const blocks = buildMergedBlocks(
      toLines('a\nb\nc\n'),
      toLines('a\nB\nc\n'),
      toLines('a\nb\nc\n'),
    );
    expect(navigable(blocks)).toHaveLength(0);
  });

  it('offers every block when nothing was decided for the user', () => {
    const blocks = blocksFor('a\nx\nb\n', 'a\nX\nb\n');
    expect(navigable(blocks).map((block) => block.id)).toEqual([0]);
  });
});

describe('editing a run of the result', () => {
  it('replaces the lines and says the block was touched', () => {
    const blocks = choose(blocksFor('one\nmine\ntwo\n', 'one\nyours\ntwo\n'), 0, 'ours');
    const index = blocks.findIndex((block) => block.kind === 'conflict');

    const after = editLines(blocks, index, 'ours', ['neither', 'but this']);

    // The edit goes into the block, so `assemble` stays the one thing that
    // builds the file — there is no second copy of the result to drift.
    expect(assembleLines(after)).toEqual(['one', 'neither', 'but this', 'two']);
    expect(conflicts(after)[0]?.edited).toBe(true);
  });

  it('can rewrite lines both sides agreed on', () => {
    const blocks = choose(blocksFor('one\nmine\ntwo\n', 'one\nyours\ntwo\n'), 0, 'ours');
    const after = editLines(blocks, 0, 'lines', ['ONE']);
    expect(assembleLines(after)).toEqual(['ONE', 'mine', 'two']);
  });

  it('lets a run be emptied, and never mutates what it was given', () => {
    const blocks = choose(blocksFor('one\nmine\ntwo\n', 'one\nyours\ntwo\n'), 0, 'ours');
    const index = blocks.findIndex((block) => block.kind === 'conflict');

    expect(assembleLines(editLines(blocks, index, 'ours', []))).toEqual(['one', 'two']);
    expect(conflicts(blocks)[0]?.ours).toEqual(['mine']);
  });

  it('addresses runs by exactly what the output pane hands back', () => {
    // The segment carries the address; a mismatch here would write an edit into
    // a different part of the file than the one on screen.
    const blocks = choose(blocksFor('one\nmine\ntwo\n', 'one\nyours\ntwo\n'), 0, 'both');
    const segments = assembleSegments(blocks);
    const theirs = segments.find((segment) => segment.origin === 'theirs');

    const after = editLines(blocks, theirs?.blockIndex ?? -1, theirs?.part ?? 'lines', [
      'typed',
    ]);
    expect(assembleLines(after)).toEqual(['one', 'mine', 'typed', 'two']);
  });
});

describe('choosing', () => {
  it('starts with nothing chosen, so a resolution has to be made', () => {
    const blocks = blocksFor('a\n', 'b\n');
    expect(undecided(blocks)).toHaveLength(1);
  });

  it('applies a choice to one block and leaves the rest alone', () => {
    const blocks = blocksFor('a\nx\nb\ny\n', 'a\nX\nb\nY\n');
    const after = choose(blocks, 0, 'ours');

    expect(conflicts(after)[0]?.choice).toBe('ours');
    expect(conflicts(after)[1]?.choice).toBeNull();
  });

  it('never mutates the blocks it was given', () => {
    const blocks = blocksFor('a\n', 'b\n');
    choose(blocks, 0, 'theirs');
    expect(conflicts(blocks)[0]?.choice).toBeNull();
  });

  it('takes every block at once for the whole-file buttons', () => {
    const blocks = chooseAll(blocksFor('a\nx\n', 'b\nX\n'), 'theirs');
    expect(undecided(blocks)).toHaveLength(0);
  });
});

describe('assembling the result', () => {
  it('is the preview and the file, from one function', () => {
    const blocks = choose(blocksFor('one\ntwo\n', 'one\nTWO\n'), 0, 'theirs');
    expect(assembleLines(blocks)).toEqual(['one', 'TWO']);
    expect(assemble(blocks, true)).toBe('one\nTWO\n');
  });

  it('keeps ours then theirs when both are wanted', () => {
    const blocks = choose(blocksFor('mine\n', 'yours\n'), 0, 'both');
    expect(assembleLines(blocks)).toEqual(['mine', 'yours']);
  });

  it('drops the block entirely when neither side is wanted', () => {
    const blocks = choose(
      blocksFor('one\nmine\ntwo\n', 'one\nyours\ntwo\n'),
      0,
      'neither',
    );
    expect(assembleLines(blocks)).toEqual(['one', 'two']);
  });

  it('leaves an undecided block out, so a half-answer looks unfinished', () => {
    // The alternative — quietly defaulting to one side — produces a preview
    // that looks complete and a file nobody chose.
    const blocks = blocksFor('one\nmine\ntwo\n', 'one\nyours\ntwo\n');
    expect(assembleLines(blocks)).toEqual(['one', 'two']);
    expect(undecided(blocks)).toHaveLength(1);
  });

  it('carries the original trailing newline rather than deciding for itself', () => {
    const blocks = choose(blocksFor('a\n', 'b\n'), 0, 'ours');
    expect(assemble(blocks, true)).toBe('a\n');
    expect(assemble(blocks, false)).toBe('a');
  });

  it('writes nothing at all for a file resolved to empty', () => {
    const blocks = choose(blocksFor('a\n', 'b\n'), 0, 'neither');
    expect(assemble(blocks, true)).toBe('');
  });

  it('round-trips a file whose sides agree, byte for byte', () => {
    const text = 'one\n\ntwo\nthree';
    const blocks = blocksFor(text, text);
    expect(assemble(blocks, endsWithNewline(text))).toBe(text);
  });
});

describe('endsWithNewline and the size guard', () => {
  it('knows whether the last byte was a newline', () => {
    expect(endsWithNewline('a\n')).toBe(true);
    expect(endsWithNewline('a')).toBe(false);
    expect(endsWithNewline('')).toBe(false);
  });

  it('refuses a file too big to compare honestly', () => {
    // The table is ours × theirs cells; at this size it is a hung window.
    const huge = `${'x\n'.repeat(MAX_LINES + 1)}`;
    expect(tooLargeToCompare(huge, 'a\n')).toBe(true);
    expect(tooLargeToCompare('a\n', 'b\n')).toBe(false);
  });
});
