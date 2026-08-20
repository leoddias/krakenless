import { describe, expect, it } from 'vitest';
import { buildGraph } from './graph';
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
    expect(crossing?.[0]).toEqual({ fromLane: 0, toLane: 1 });
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
