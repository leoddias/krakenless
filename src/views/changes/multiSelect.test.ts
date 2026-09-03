import { describe, expect, it } from 'vitest';
import {
  EMPTY_SELECTION,
  nextSelection,
  pruneSelection,
  rangeBetween,
  selectOnly,
  selectedInOrder,
  type Selection,
} from './multiSelect';

const ORDER = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];

const sel = (paths: string[], anchor: string | null): Selection => ({
  paths: new Set(paths),
  anchor,
});

const click = (path: string) => ({ path, shift: false, toggle: false });
const shiftClick = (path: string) => ({ path, shift: true, toggle: false });
const toggleClick = (path: string) => ({ path, shift: false, toggle: true });

/** Selection as a sorted array, so assertions do not depend on insertion order. */
const paths = (selection: Selection): string[] => [...selection.paths].sort();

describe('rangeBetween', () => {
  it('reads downwards', () => {
    expect(rangeBetween(ORDER, 'b.ts', 'd.ts')).toEqual(['b.ts', 'c.ts', 'd.ts']);
  });

  it('reads upwards to the same range', () => {
    expect(rangeBetween(ORDER, 'd.ts', 'b.ts')).toEqual(['b.ts', 'c.ts', 'd.ts']);
  });

  it('is one file when both ends are the same', () => {
    expect(rangeBetween(ORDER, 'c.ts', 'c.ts')).toEqual(['c.ts']);
  });

  it('is empty when an end is not in the list, rather than guessing', () => {
    expect(rangeBetween(ORDER, 'gone.ts', 'c.ts')).toEqual([]);
    expect(rangeBetween(ORDER, 'c.ts', 'gone.ts')).toEqual([]);
  });
});

describe('nextSelection, plain click', () => {
  it('selects one file and anchors there', () => {
    expect(nextSelection(ORDER, EMPTY_SELECTION, click('c.ts'))).toEqual(
      selectOnly('c.ts'),
    );
  });

  it('replaces a bigger selection', () => {
    const after = nextSelection(
      ORDER,
      sel(['a.ts', 'b.ts', 'c.ts'], 'a.ts'),
      click('e.ts'),
    );
    expect(paths(after)).toEqual(['e.ts']);
    expect(after.anchor).toBe('e.ts');
  });

  it('ignores a click on a path that is not in the list', () => {
    const before = selectOnly('a.ts');
    expect(nextSelection(ORDER, before, click('gone.ts'))).toBe(before);
  });
});

describe('nextSelection, shift-click', () => {
  it('selects the range from the anchor, inclusive', () => {
    const after = nextSelection(ORDER, selectOnly('b.ts'), shiftClick('d.ts'));
    expect(paths(after)).toEqual(['b.ts', 'c.ts', 'd.ts']);
  });

  it('extends upwards just as well', () => {
    const after = nextSelection(ORDER, selectOnly('d.ts'), shiftClick('b.ts'));
    expect(paths(after)).toEqual(['b.ts', 'c.ts', 'd.ts']);
  });

  it('keeps the anchor, so a second shift-click regrows the same range', () => {
    const first = nextSelection(ORDER, selectOnly('b.ts'), shiftClick('e.ts'));
    expect(first.anchor).toBe('b.ts');

    const second = nextSelection(ORDER, first, shiftClick('c.ts'));

    expect(paths(second)).toEqual(['b.ts', 'c.ts']);
    expect(second.anchor).toBe('b.ts');
  });

  it('is a plain click when there is no anchor yet', () => {
    const after = nextSelection(ORDER, EMPTY_SELECTION, shiftClick('c.ts'));
    expect(paths(after)).toEqual(['c.ts']);
    expect(after.anchor).toBe('c.ts');
  });

  it('is a plain click when the anchor has left the list', () => {
    // What happens the moment a selected file is staged: it moves to the other
    // section and the anchor points at a row that is no longer drawn. Selecting
    // from the top of the list instead would stage files nobody pointed at.
    const stale = sel(['c.ts'], 'staged-away.ts');

    const after = nextSelection(ORDER, stale, shiftClick('d.ts'));

    expect(paths(after)).toEqual(['d.ts']);
    expect(after.anchor).toBe('d.ts');
  });

  it('selects one file when shift-clicking the anchor itself', () => {
    const after = nextSelection(ORDER, selectOnly('c.ts'), shiftClick('c.ts'));
    expect(paths(after)).toEqual(['c.ts']);
  });
});

describe('nextSelection, toggle click', () => {
  it('adds a file to the selection', () => {
    const after = nextSelection(ORDER, selectOnly('a.ts'), toggleClick('d.ts'));
    expect(paths(after)).toEqual(['a.ts', 'd.ts']);
    expect(after.anchor).toBe('d.ts');
  });

  it('removes a file that was selected', () => {
    const after = nextSelection(
      ORDER,
      sel(['a.ts', 'd.ts'], 'a.ts'),
      toggleClick('a.ts'),
    );
    expect(paths(after)).toEqual(['d.ts']);
  });

  it('moves the anchor even when it deselected, so the next range starts there', () => {
    const after = nextSelection(
      ORDER,
      sel(['a.ts', 'd.ts'], 'a.ts'),
      toggleClick('d.ts'),
    );
    expect(after.anchor).toBe('d.ts');
  });

  it('can empty the selection', () => {
    const after = nextSelection(ORDER, selectOnly('a.ts'), toggleClick('a.ts'));
    expect(paths(after)).toEqual([]);
  });
});

describe('pruneSelection', () => {
  it('drops paths that have left the list', () => {
    const after = pruneSelection(ORDER, sel(['a.ts', 'gone.ts'], 'a.ts'));
    expect(paths(after)).toEqual(['a.ts']);
  });

  it('clears an anchor that has left the list', () => {
    expect(pruneSelection(ORDER, sel(['a.ts'], 'gone.ts')).anchor).toBeNull();
  });

  it('returns the same object when nothing changed, so it is safe every render', () => {
    const before = sel(['a.ts', 'b.ts'], 'a.ts');
    expect(pruneSelection(ORDER, before)).toBe(before);
  });

  it('empties a selection whose files have all gone', () => {
    expect(paths(pruneSelection(ORDER, sel(['x.ts', 'y.ts'], 'x.ts')))).toEqual([]);
  });
});

describe('selectedInOrder', () => {
  it('returns the list order, not the order they were clicked', () => {
    const clicked = nextSelection(
      ORDER,
      nextSelection(ORDER, selectOnly('e.ts'), toggleClick('b.ts')),
      toggleClick('c.ts'),
    );
    expect(selectedInOrder(ORDER, clicked)).toEqual(['b.ts', 'c.ts', 'e.ts']);
  });

  it('is empty for an empty selection', () => {
    expect(selectedInOrder(ORDER, EMPTY_SELECTION)).toEqual([]);
  });
});
