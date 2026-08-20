import { describe, expect, it } from 'vitest';
import { buildGraph, type GraphEdge } from './graph';
import type { Commit } from '../../git/types';

/** Minimal commit; only oid and parents matter to the layout. */
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

describe('buildGraph', () => {
  it('keeps a linear history in one lane', () => {
    const graph = buildGraph([commit('c', ['b']), commit('b', ['a']), commit('a')]);

    expect(graph.rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(graph.laneCount).toBe(1);
  });

  it('gives a merge a second lane for its other parent', () => {
    //   m       merge of main (a) and topic (t)
    //   |\
    //   a t
    const graph = buildGraph([
      commit('m', ['a', 't']),
      commit('a', ['root']),
      commit('t', ['root']),
      commit('root'),
    ]);

    expect(graph.rows[0]?.isMerge).toBe(true);
    // The first parent stays in the merge's lane; the second opens another.
    expect(graph.rows[1]?.lane).toBe(0);
    expect(graph.rows[2]?.lane).toBe(1);
    expect(graph.laneCount).toBeGreaterThanOrEqual(2);
  });

  it('draws an edge from the merge across to the lane it opened', () => {
    const graph = buildGraph([commit('m', ['a', 't']), commit('a'), commit('t')]);

    const crossing = graph.rows[0]?.edges.filter((edge) => edge.fromLane !== edge.toLane);
    expect(crossing).toHaveLength(1);
    // It leaves the node and lands on the lane at the row's bottom edge, where
    // the next row picks it up.
    expect(crossing?.[0]).toEqual({
      fromLane: 0,
      toLane: 1,
      from: 'node',
      to: 'bottom',
    });
  });

  it('frees a lane once its branch is exhausted', () => {
    // After `t` is placed, lane 1 is free again and the next unrelated commit
    // reuses it rather than growing the graph forever.
    const graph = buildGraph([
      commit('m', ['a', 't']),
      commit('a', ['root']),
      commit('t'),
      commit('root'),
      commit('other'),
    ]);

    expect(graph.rows[4]?.lane).toBeLessThanOrEqual(1);
  });

  it('reports a merge as a merge and an ordinary commit as not', () => {
    const graph = buildGraph([commit('m', ['a', 'b']), commit('a'), commit('b')]);
    expect(graph.rows.map((row) => row.isMerge)).toEqual([true, false, false]);
  });

  it('keeps a lane for a parent outside the loaded page', () => {
    // The page ends before `older` is loaded. The lane must stay reserved, or
    // the last row would draw an edge that stops in mid-air.
    const graph = buildGraph([commit('c', ['older'])]);
    expect(graph.rows[0]?.edges.length).toBeGreaterThan(0);
    expect(graph.laneCount).toBe(1);
  });

  it('handles an empty history', () => {
    const graph = buildGraph([]);
    expect(graph.rows).toEqual([]);
    // Never zero: the view reserves this much width, and zero would collapse
    // the column and shift every row.
    expect(graph.laneCount).toBe(1);
  });

  it('handles a root commit with no parents', () => {
    const graph = buildGraph([commit('root')]);
    expect(graph.rows[0]).toMatchObject({ oid: 'root', lane: 0, isMerge: false });
  });

  it('is stable: the same input yields the same lanes', () => {
    const input = [commit('m', ['a', 't']), commit('a', ['root']), commit('t', ['root'])];
    expect(buildGraph(input).rows).toEqual(buildGraph(input).rows);
  });

  it('handles an octopus merge without losing a parent', () => {
    const graph = buildGraph([
      commit('o', ['a', 'b', 'c']),
      commit('a'),
      commit('b'),
      commit('c'),
    ]);

    const crossings = graph.rows[0]?.edges.filter(
      (edge) => edge.fromLane !== edge.toLane,
    );
    expect(crossings).toHaveLength(2);
    expect(graph.laneCount).toBeGreaterThanOrEqual(3);
  });
});

describe('buildGraph geometry (regression: dangling edges)', () => {
  /** Lanes a row's edges reach at the row's bottom boundary. */
  function bottomLanes(row: { edges: GraphEdge[] }): number[] {
    return [
      ...new Set(row.edges.filter((e) => e.to === 'bottom').map((e) => e.toLane)),
    ].sort((a, b) => a - b);
  }

  /** Lanes a row's edges start from at the row's top boundary. */
  function topLanes(row: { edges: GraphEdge[] }): number[] {
    return [
      ...new Set(row.edges.filter((e) => e.from === 'top').map((e) => e.fromLane)),
    ].sort((a, b) => a - b);
  }

  // The shape from the bug report: a merge whose second parent sits on another
  // lane, with commits above and below it on the main lane.
  const screenshot = [
    commit('top', ['merge']),
    commit('merge', ['main1', 'topic']),
    commit('main1', ['base']),
    commit('topic', ['base']),
    commit('base'),
  ];

  it('does not draw a full-height line in the lane a merge opens', () => {
    // The lane only exists from the merge node downwards. A vertical segment
    // spanning the merge's row would start in mid-air beside the node.
    const merge = buildGraph(screenshot).rows[1];
    const opened = merge?.edges.filter((edge) => edge.toLane === 1);

    expect(opened).toHaveLength(1);
    expect(opened?.[0]).toEqual({
      fromLane: 0,
      toLane: 1,
      from: 'node',
      to: 'bottom',
    });
  });

  it('connects a merge to its second parent with no gap in between', () => {
    const graph = buildGraph(screenshot);
    // The merge leaves its node for lane 1 ...
    expect(graph.rows[1]?.edges).toContainEqual({
      fromLane: 0,
      toLane: 1,
      from: 'node',
      to: 'bottom',
    });
    // ... the row between carries lane 1 straight through ...
    expect(graph.rows[2]?.edges).toContainEqual({
      fromLane: 1,
      toLane: 1,
      from: 'top',
      to: 'bottom',
    });
    // ... and the parent's own row receives it at the node.
    expect(graph.rows[3]?.lane).toBe(1);
    expect(graph.rows[3]?.edges).toContainEqual({
      fromLane: 1,
      toLane: 1,
      from: 'top',
      to: 'node',
    });
  });

  it('closes a lane that rejoins another instead of leaving it waiting', () => {
    const graph = buildGraph(screenshot);
    // `topic`'s parent `base` already waits in lane 0, so lane 1 ends here
    // with a line across, and nothing below draws in lane 1.
    expect(graph.rows[3]?.edges).toContainEqual({
      fromLane: 1,
      toLane: 0,
      from: 'node',
      to: 'bottom',
    });
    expect(graph.rows[4]?.edges.some((edge) => edge.fromLane === 1)).toBe(false);
    expect(graph.rows[4]?.edges.some((edge) => edge.toLane === 1)).toBe(false);
  });

  it('leaves no lane occupied after the branch that opened it is placed', () => {
    // The defect this guards: two lanes waiting for the same parent left one
    // of them stale, drawing a line down the rest of the history to nothing.
    const graph = buildGraph(screenshot);
    expect(graph.rows.map((row) => bottomLanes(row))).toEqual([
      [0],
      [0, 1],
      [0, 1],
      [0],
      [],
    ]);
  });

  it('meets across every row boundary, for every shape we lay out', () => {
    const histories: Commit[][] = [
      screenshot,
      [commit('c', ['b']), commit('b', ['a']), commit('a')],
      [
        commit('o', ['a', 'b', 'c']),
        commit('a', ['root']),
        commit('b', ['root']),
        commit('c', ['root']),
        commit('root'),
      ],
      [
        commit('m', ['a', 't']),
        commit('a', ['root']),
        commit('t', ['root']),
        commit('root'),
        commit('unrelated'),
      ],
      [commit('twice', ['p', 'p']), commit('p')],
      // A first parent rejoining an existing lane while a second parent takes
      // over the lane this commit just vacated.
      [
        commit('m', ['a', 'x']),
        commit('a', ['root']),
        commit('x', ['root']),
        commit('root'),
      ],
      // A parent listed above its own child, which `git log` emits whenever
      // commit dates disagree with topology.
      [commit('a', ['root']), commit('b', ['a']), commit('root')],
      [commit('c1', ['c3', 'c2', 'c3']), commit('c2', ['c3']), commit('c3')],
      // A merge whose *both* parents were already drawn above it.
      [commit('p'), commit('t'), commit('m', ['p', 't'])],
    ];

    for (const history of histories) {
      const graph = buildGraph(history);
      for (let index = 0; index + 1 < graph.rows.length; index += 1) {
        const above = graph.rows[index];
        const below = graph.rows[index + 1];
        if (above === undefined || below === undefined) throw new Error('missing row');
        // Reported as an object so a failure names the boundary that broke.
        expect({ row: index, lanes: bottomLanes(above) }).toEqual({
          row: index,
          lanes: topLanes(below),
        });
      }
    }
  });

  it('starts every lane-changing edge at the node and ends it at the boundary', () => {
    const graph = buildGraph(screenshot);
    for (const row of graph.rows)
      for (const edge of row.edges)
        if (edge.fromLane !== edge.toLane) {
          expect(edge.fromLane).toBe(row.lane);
          expect(edge.from).toBe('node');
          expect(edge.to).toBe('bottom');
        }
  });

  it('draws no line above the first commit of a lane', () => {
    const graph = buildGraph([commit('tip', ['older'])]);
    expect(graph.rows[0]?.edges).toEqual([
      { fromLane: 0, toLane: 0, from: 'node', to: 'bottom' },
    ]);
  });

  it('draws no line below a commit with no parents', () => {
    const graph = buildGraph([commit('c', ['root']), commit('root')]);
    expect(graph.rows[1]?.edges).toEqual([
      { fromLane: 0, toLane: 0, from: 'top', to: 'node' },
    ]);
  });

  it('reserves no lane for a parent already drawn above', () => {
    // `git log` is not topologically ordered by default, so a parent can be
    // emitted above its child. Reserving a lane for `a` at `b`'s row would run
    // a line to the bottom of the page waiting for a commit already past.
    const graph = buildGraph([commit('a', ['root']), commit('b', ['a']), commit('root')]);

    expect(graph.rows[1]?.edges).toEqual([
      { fromLane: 0, toLane: 0, from: 'top', to: 'bottom' },
    ]);
    // `b` still sits in a lane of its own — lane 0 is held by `root` — but
    // that lane carries no line, above or below, in any row.
    expect(graph.rows[1]?.lane).toBe(1);
    const lanesDrawn = graph.rows.flatMap((row) =>
      row.edges.flatMap((edge) => [edge.fromLane, edge.toLane]),
    );
    expect([...new Set(lanesDrawn)]).toEqual([0]);
  });

  it('draws a merge whose parents are both above it with no line at all', () => {
    // Pinned deliberately, not desired: an edge can only run downwards, so a
    // parent already drawn above cannot be connected. Drawing nothing is inert
    // — it reads as "not connected in what is loaded" — where the alternative
    // was a line running to the bottom of the page for a commit already past,
    // which invites a false reading of the history. Ordering `git log`
    // topologically is what would make this case unreachable.
    const graph = buildGraph([commit('p'), commit('t'), commit('m', ['p', 't'])]);
    expect(graph.rows[2]?.edges).toEqual([]);
  });

  it('draws one line, not two, when the same parent is listed twice', () => {
    // `commit-tree -p X -p X` is legal, and so is a filter-branch artefact.
    // Two identical segments are one line drawn twice.
    const graph = buildGraph([
      commit('c1', ['c3', 'c2', 'c3']),
      commit('c2', ['c3']),
      commit('c3'),
    ]);

    const crossings = graph.rows[0]?.edges.filter(
      (edge) => edge.fromLane !== edge.toLane,
    );
    expect(crossings).toHaveLength(1);
    expect(graph.rows[0]?.edges).toEqual(
      // No duplicate: a set of the serialised edges is the same size.
      [...new Set((graph.rows[0]?.edges ?? []).map((edge) => JSON.stringify(edge)))].map(
        (edge) => JSON.parse(edge) as GraphEdge,
      ),
    );
  });
});
