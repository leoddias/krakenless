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

function renderCell(graphRow: GraphRow, laneCount: number): SVGSVGElement {
  const { container } = render(
    <GraphCell row={graphRow} laneCount={laneCount} rowHeight={44} />,
  );
  const svg = container.querySelector('svg');
  if (svg === null) throw new Error('no graph rendered');
  return svg;
}

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
    expect(wide).toBeLessThanOrEqual(40);
  });

  it('still draws the full graph inside the clipped area', () => {
    // The viewBox keeps the real geometry; only the visible slice is capped.
    const svg = renderCell(row(), 40);
    expect(svg.getAttribute('viewBox')).toBe('0 0 400 44');
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

  it('is hidden from assistive technology, since the row already says it', () => {
    expect(renderCell(row(), 1).getAttribute('aria-hidden')).toBe('true');
  });
});
