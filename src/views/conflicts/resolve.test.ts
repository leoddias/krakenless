import { describe, expect, it } from 'vitest';
import {
  assemble,
  assembleLines,
  buildBlocks,
  choose,
  chooseAll,
  conflictCount,
  endsWithNewline,
  MAX_LINES,
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
