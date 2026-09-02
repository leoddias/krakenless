import { describe, expect, it } from 'vitest';
import type { DiffLine, FileDiff, Hunk } from '../../git/types';
import { FILE_LINE_BUDGET, planFiles, planKey, sliceHunks } from './renderPlan';

function lines(count: number, kind: DiffLine['kind'] = 'context'): DiffLine[] {
  return Array.from({ length: count }, (_, i) => ({
    kind,
    text: `line ${i}`,
    ...(kind === 'deleted' ? { oldLine: i + 1 } : { newLine: i + 1 }),
  }));
}

function hunk(count: number, kind: DiffLine['kind'] = 'context'): Hunk {
  return {
    header: `@@ -1,${count} +1,${count} @@`,
    oldStart: 1,
    oldLines: count,
    newStart: 1,
    newLines: count,
    lines: lines(count, kind),
  };
}

function file(path: string, hunks: Hunk[], side: FileDiff['side'] = 'commit'): FileDiff {
  return {
    oldPath: path,
    newPath: path,
    kind: 'modified',
    binary: false,
    conflicted: false,
    side,
    headerLines: [],
    hunks,
  };
}

const NONE: ReadonlyMap<string, number> = new Map();

describe('planFiles', () => {
  it('shows a small diff in full', () => {
    const plans = planFiles([file('a.ts', [hunk(10)]), file('b.ts', [hunk(5)])], NONE);
    expect(plans.map((p) => p.visible)).toEqual([10, 5]);
    expect(plans.map((p) => p.total)).toEqual([10, 5]);
  });

  it('collapses a file larger than the per-file budget', () => {
    const big = file('big.lock', [hunk(FILE_LINE_BUDGET + 1)]);
    const small = file('a.ts', [hunk(3)]);
    const plans = planFiles([big, small], NONE);
    expect(plans[0]?.visible).toBe(0);
    // The neighbour is unaffected: collapsing is per file, not per panel.
    expect(plans[1]?.visible).toBe(3);
  });

  it('counts added and deleted lines exactly once, in the plan', () => {
    const mixed = file('a.ts', [hunk(4, 'added'), hunk(2, 'deleted'), hunk(3)]);
    const [plan] = planFiles([mixed], NONE);
    expect(plan).toMatchObject({ total: 9, added: 4, deleted: 2 });
  });

  it('does not count a no-newline marker as content', () => {
    const marker = file('a.ts', [
      {
        ...hunk(1, 'added'),
        lines: [
          { kind: 'added', text: 'x', newLine: 1 },
          { kind: 'no-newline', text: 'No newline at end of file' },
        ],
      },
    ]);
    const [plan] = planFiles([marker], NONE);
    expect(plan).toMatchObject({ added: 1, deleted: 0 });
  });

  it('plans each file on its own size, however many there are', () => {
    // There used to be a whole-panel budget here, from when every file's diff
    // was mounted at once. The panel draws one file now, so a file's neighbours
    // are none of its business — the fiftieth small file is as readable as the
    // first, without a click.
    const many = Array.from({ length: 50 }, (_, i) => file(`f${i}.ts`, [hunk(100)]));
    const plans = planFiles(many, NONE);
    expect(plans.every((p) => p.visible === 100)).toBe(true);
  });

  it('always honors an explicit reveal, budget or not', () => {
    const big = file('big.lock', [hunk(5_000)]);
    const revealed = new Map([[planKey(big), 1_000]]);
    const [plan] = planFiles([big], revealed);
    expect(plan?.visible).toBe(1_000);
  });

  it('never reveals more lines than the file has', () => {
    const small = file('a.ts', [hunk(10)]);
    const revealed = new Map([[planKey(small), 9_999]]);
    expect(planFiles([small], revealed)[0]?.visible).toBe(10);
  });

  it('keys by side and path, so the same path staged and unstaged stay apart', () => {
    const a = file('a.ts', [], 'unstaged');
    const b = file('a.ts', [], 'staged');
    expect(planKey(a)).not.toBe(planKey(b));
  });
});

describe('sliceHunks', () => {
  it('keeps whole hunks when they fit', () => {
    const f = file('a.ts', [hunk(3), hunk(4)]);
    const slices = sliceHunks(f, 7);
    expect(slices.map((s) => s.lines.length)).toEqual([3, 4]);
    expect(slices.map((s) => s.hidden)).toEqual([0, 0]);
  });

  it('truncates only the last visible hunk and reports the hidden tail', () => {
    const f = file('a.ts', [hunk(3), hunk(10)]);
    const slices = sliceHunks(f, 5);
    expect(slices.map((s) => s.lines.length)).toEqual([3, 2]);
    expect(slices[1]?.hidden).toBe(8);
  });

  it('renders nothing for a collapsed file', () => {
    expect(sliceHunks(file('a.ts', [hunk(10)]), 0)).toEqual([]);
  });

  it('hands back the original hunk object, never a trimmed copy', () => {
    // Staging acts on `slice.hunk`; a trimmed hunk fed to `git apply` would be
    // a different patch than the one parsed. The original must survive intact.
    const original = hunk(10);
    const [slice] = sliceHunks(file('a.ts', [original]), 4);
    expect(slice?.hunk).toBe(original);
    expect(slice?.hunk.lines.length).toBe(10);
    expect(slice?.lines.length).toBe(4);
  });

  it('does not slice a hunk that is shown in full', () => {
    const original = hunk(4);
    const [slice] = sliceHunks(file('a.ts', [original]), 4);
    expect(slice?.lines).toBe(original.lines);
  });
});
