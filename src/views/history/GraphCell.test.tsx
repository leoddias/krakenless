import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GraphCell } from './GraphCell';
import type { GraphRow } from './graph';

function row(overrides: Partial<GraphRow> = {}): GraphRow {
  return {
    oid: 'abc1234',
    lane: 0,
    edges: [{ fromLane: 0, toLane: 0 }],
    isMerge: false,
    ...overrides,
  };
}

function renderCell(
  graphRow: GraphRow,
  laneCount: number,
  author?: { name: string; email: string },
): SVGSVGElement {
  const { container } = render(
    <GraphCell
      row={graphRow}
      laneCount={laneCount}
      rowHeight={44}
      {...(author === undefined ? {} : { author })}
    />,
  );
  const svg = container.querySelector('svg');
  if (svg === null) throw new Error('no graph rendered');
  return svg;
}

const ADA = { name: 'Ada Lovelace', email: 'ada@example.com' };

describe('GraphCell', () => {
  it('reserves width proportional to a narrow graph', () => {
    const narrow = Number(renderCell(row(), 1).getAttribute('width'));
    const wider = Number(renderCell(row(), 3).getAttribute('width'));
    expect(wider).toBeGreaterThan(narrow);
  });

  it('stops reserving width for a repository with many branches', () => {
    // `laneCount` is the widest point of the whole list and every row reserves
    // it, so an uncapped graph pushes the commit subject off every line — the
    // one thing the row exists to show.
    const wide = Number(renderCell(row(), 40).getAttribute('width'));
    const capped = Number(renderCell(row(), 4).getAttribute('width'));
    expect(wide).toBe(capped);
    expect(wide).toBeLessThanOrEqual(72);
  });

  it('still draws the full graph inside the clipped area', () => {
    // The viewBox keeps the real geometry; only the visible slice is capped.
    const svg = renderCell(row(), 40);
    expect(svg.getAttribute('viewBox')).toBe('0 0 720 44');
  });

  it('marks a merge differently from an ordinary commit', () => {
    const ordinary = renderCell(row(), 1).querySelector('circle');
    const merge = renderCell(row({ isMerge: true }), 1).querySelector('circle');
    expect(ordinary?.getAttribute('class')).not.toBe(merge?.getAttribute('class'));
  });

  it('draws one path per edge', () => {
    const svg = renderCell(
      row({
        edges: [
          { fromLane: 0, toLane: 0 },
          { fromLane: 0, toLane: 1 },
        ],
      }),
      2,
    );
    expect(svg.querySelectorAll('path')).toHaveLength(2);
  });

  it('keeps duplicate lane pairs from collapsing into one path', () => {
    // A commit may legitimately list the same parent twice; a lane-pair key
    // would drop one of the two edges.
    const svg = renderCell(
      row({
        edges: [
          { fromLane: 0, toLane: 1 },
          { fromLane: 0, toLane: 1 },
        ],
      }),
      2,
    );
    expect(svg.querySelectorAll('path')).toHaveLength(2);
  });

  it('draws the author badge in place of the node when an author is given', () => {
    const svg = renderCell(row(), 1, ADA);
    expect(svg.querySelector('text')?.textContent).toBe('AL');
  });

  it('colours the badge from the identity rather than from a stylesheet', () => {
    // The colour is per-author data, so it must survive as an attribute on the
    // circle; a class would let the sheet's node colour win over it.
    const ada = renderCell(row(), 1, ADA).querySelector('circle');
    const grace = renderCell(row(), 1, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
    }).querySelector('circle');
    expect(ada?.getAttribute('fill')).toMatch(/^hsl\(/);
    expect(ada?.getAttribute('fill')).not.toBe(grace?.getAttribute('fill'));
  });

  it('still marks a merge when the node carries a badge', () => {
    const ordinary = renderCell(row(), 1, ADA).querySelector('circle');
    const merge = renderCell(row({ isMerge: true }), 1, ADA).querySelector('circle');
    expect(ordinary?.getAttribute('class')).not.toBe(merge?.getAttribute('class'));
  });

  it('is hidden from assistive technology, since the row already says it', () => {
    expect(renderCell(row(), 1).getAttribute('aria-hidden')).toBe('true');
  });
});
