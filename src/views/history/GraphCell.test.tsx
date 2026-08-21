import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GraphCell } from './GraphCell';
import { buildGraph, type GraphRow } from './graph';
import type { Commit } from '../../git/types';

function row(overrides: Partial<GraphRow> = {}): GraphRow {
  return {
    oid: 'abc1234',
    lane: 0,
    edges: [{ fromLane: 0, toLane: 0, from: 'top', to: 'bottom' }],
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
          { fromLane: 0, toLane: 0, from: 'top', to: 'bottom' },
          { fromLane: 0, toLane: 1, from: 'node', to: 'bottom' },
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
          { fromLane: 0, toLane: 1, from: 'node', to: 'bottom' },
          { fromLane: 0, toLane: 1, from: 'node', to: 'bottom' },
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

/** Lane 0 sits at x=9, lane 1 at x=27; the rows rendered here are 44 high. */
describe('GraphCell geometry (regression: dangling edges)', () => {
  function paths(graphRow: GraphRow, laneCount: number): string[] {
    return [...renderCell(graphRow, laneCount).querySelectorAll('path')].map(
      (path) => path.getAttribute('d') ?? '',
    );
  }

  it('runs a passing lane the full height of the row', () => {
    expect(
      paths(row({ edges: [{ fromLane: 1, toLane: 1, from: 'top', to: 'bottom' }] }), 2),
    ).toEqual(['M 27 0 L 27 44']);
  });

  it('stops an arriving line at the node instead of overshooting', () => {
    expect(
      paths(row({ edges: [{ fromLane: 0, toLane: 0, from: 'top', to: 'node' }] }), 1),
    ).toEqual(['M 9 0 L 9 22']);
  });

  it('starts a leaving line at the node instead of at the row top', () => {
    expect(
      paths(row({ edges: [{ fromLane: 0, toLane: 0, from: 'node', to: 'bottom' }] }), 1),
    ).toEqual(['M 9 22 L 9 44']);
  });

  it('curves from the node to the target lane, ending on the row boundary', () => {
    expect(
      paths(row({ edges: [{ fromLane: 0, toLane: 1, from: 'node', to: 'bottom' }] }), 2),
    ).toEqual(['M 9 22 C 9 33, 27 33, 27 44']);
  });
});

describe('GraphCell over a real graph', () => {
  function commit(oid: string, parents: string[] = []): Commit {
    return {
      oid,
      shortOid: oid.slice(0, 7),
      parents,
      authorName: 'A',
      authorEmail: 'a@example.com',
      authorDate: '2026-08-20T10:00:00+00:00',
      committerName: 'A',
      committerDate: '2026-08-20T10:00:00+00:00',
      subject: oid,
      body: '',
      refs: [],
    };
  }

  // The shape from the bug report: a merge whose second parent sits on another
  // lane, with commits above and below it on the main lane.
  const graph = buildGraph([
    commit('top', ['merge']),
    commit('merge', ['main1', 'topic']),
    commit('main1', ['base']),
    commit('topic', ['base']),
    commit('base'),
  ]);

  function pathsOfRow(index: number): string[] {
    const graphRow = graph.rows[index];
    if (graphRow === undefined) throw new Error(`no row ${index}`);
    return [...renderCell(graphRow, graph.laneCount).querySelectorAll('path')].map(
      (path) => path.getAttribute('d') ?? '',
    );
  }

  it('draws nothing in the merge row above the lane the merge opens', () => {
    // The defect: lane 1 got a full-height vertical here, so a line began in
    // mid-air beside the merge node and ran down connected to nothing.
    expect(pathsOfRow(1)).toEqual(['M 9 0 L 9 44', 'M 9 22 C 9 33, 27 33, 27 44']);
  });

  it('carries lane 1 from the merge down to the parent without a break', () => {
    // The merge's curve ends at (27, 44); the row below runs 27 from 0 to 44;
    // the parent's own row takes it from 0 down to its node at 22.
    expect(pathsOfRow(2)).toContain('M 27 0 L 27 44');
    expect(pathsOfRow(3)).toContain('M 27 0 L 27 22');
  });

  it('draws no line in a lane after its branch has rejoined the main one', () => {
    expect(pathsOfRow(4)).toEqual(['M 9 0 L 9 22']);
  });
});

describe('GraphCell for a stash', () => {
  function renderStash(): SVGSVGElement {
    const { container } = render(
      <GraphCell
        row={row()}
        laneCount={1}
        rowHeight={30}
        author={{ name: 'Ada Lovelace', email: 'ada@example.com' }}
        stash
      />,
    );
    const svg = container.querySelector('svg');
    if (svg === null) throw new Error('no svg rendered');
    return svg;
  }

  it('draws a box rather than a circle', () => {
    const svg = renderStash();
    expect(svg.querySelector('rect')).not.toBeNull();
    expect(svg.querySelector('circle')).toBeNull();
  });

  it('does not show the author — a stash is not attributed to anyone', () => {
    expect(renderStash().querySelector('text')).toBeNull();
  });

  it('marks the box dashed, which is what says "set aside"', () => {
    const rect = renderStash().querySelector('rect');
    expect(rect?.getAttribute('class')).toMatch(/graphStash/);
  });

  it('still draws the lane the row sits in', () => {
    expect(renderStash().querySelectorAll('path').length).toBeGreaterThan(0);
  });
});
