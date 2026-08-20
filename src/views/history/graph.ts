/**
 * Laying out the commit graph.
 *
 * Pure: takes commits in the order git produced them and returns, per row, the
 * lane the commit sits in and the edges passing through. No rendering, no
 * measurement, so the layout rules are testable on their own.
 *
 * The goal from `docs/ROADMAP.md` is "functional, not beautiful": the user must
 * be able to see that two commits are connected and where a branch diverged.
 * Anything fancier can come later.
 */

import type { Commit } from '../../git/types';

/** A line segment crossing one row, from `fromLane` at the top to `toLane`. */
export interface GraphEdge {
  fromLane: number;
  toLane: number;
}

export interface GraphRow {
  oid: string;
  /** Column the commit's node sits in. */
  lane: number;
  /** Segments drawn through this row, including the one ending at the node. */
  edges: GraphEdge[];
  /** True when this commit has more than one parent. */
  isMerge: boolean;
}

export interface Graph {
  rows: GraphRow[];
  /** Widest point, so the view can reserve exactly the space needed. */
  laneCount: number;
}

/**
 * Assigns lanes to commits, oldest-last (git's own order).
 *
 * The rule is deliberately simple: a commit takes the leftmost lane that is
 * already waiting for it, or the leftmost free lane if none is. Its first
 * parent inherits that lane, and any additional parent claims a new one — which
 * is what makes a merge visibly fan out and a branch visibly rejoin.
 *
 * Commits whose parents are outside the loaded page keep their lane reserved to
 * the end of the page rather than being dropped, so a partially loaded history
 * does not draw an edge that stops in mid-air.
 */
export function buildGraph(commits: Commit[]): Graph {
  // Lane slot -> oid the lane is currently waiting for. `null` means free.
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let laneCount = 0;

  const claim = (oid: string): number => {
    const existing = lanes.indexOf(oid);
    if (existing !== -1) return existing;
    const free = lanes.indexOf(null);
    if (free !== -1) {
      lanes[free] = oid;
      return free;
    }
    lanes.push(oid);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    const lane = claim(commit.oid);
    const before = lanes.map((waiting) => waiting);

    // The first parent continues this lane; the rest open their own.
    const [firstParent, ...otherParents] = commit.parents;
    lanes[lane] = firstParent ?? null;
    for (const parent of otherParents) claim(parent);

    const edges: GraphEdge[] = [];
    for (let slot = 0; slot < Math.max(before.length, lanes.length); slot += 1) {
      const wasActive = before[slot] !== null && before[slot] !== undefined;
      const isActive = lanes[slot] !== null && lanes[slot] !== undefined;
      if (!wasActive && !isActive && slot !== lane) continue;

      if (slot === lane) {
        // The node's own segment. It is always vertical: a lane that ends here
        // still draws through the row so the node sits on a line rather than
        // floating, and a lane that continues looks identical.
        edges.push({ fromLane: lane, toLane: lane });
        continue;
      }
      if (wasActive || isActive) edges.push({ fromLane: slot, toLane: slot });
    }

    // A parent that opened a new lane draws a line from the node across to it.
    for (const parent of otherParents) {
      const target = lanes.indexOf(parent);
      if (target !== -1 && target !== lane)
        edges.push({ fromLane: lane, toLane: target });
    }

    laneCount = Math.max(
      laneCount,
      lanes.filter((waiting) => waiting !== null).length,
      lane + 1,
    );
    rows.push({
      oid: commit.oid,
      lane,
      edges,
      isMerge: commit.parents.length > 1,
    });
  }

  return { rows, laneCount: Math.max(laneCount, 1) };
}
