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

/**
 * Where a segment's end sits vertically inside its row.
 *
 * `top` and `bottom` are the row's own boundaries, so a segment ending at
 * `bottom` meets — to the pixel — the segment starting at `top` of the next
 * row in the same lane. `node` is the commit's centre. Anything else would
 * leave a gap, which is exactly the bug this vocabulary exists to prevent.
 */
export type GraphAnchor = 'top' | 'node' | 'bottom';

/** A line segment inside one row, from (`fromLane`, `from`) to (`toLane`, `to`). */
export interface GraphEdge {
  fromLane: number;
  toLane: number;
  from: 'top' | 'node';
  to: 'node' | 'bottom';
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
 * parent inherits that lane unless another lane is already waiting for that
 * parent — in which case this branch rejoins that lane and its own lane closes.
 * Additional parents reuse the lane already waiting for them, or open a new one,
 * which is what makes a merge visibly fan out.
 *
 * Two invariants keep the drawing continuous, and both were once broken:
 * - a lane is occupied for a whole row or not at all, except at the row of the
 *   commit that occupies it, where the segments stop at the node. A lane opened
 *   by a merge therefore gets no line above that merge's node;
 * - no lane is left waiting for a commit that another lane already claims, so
 *   nothing draws a line down the rest of the history to nothing.
 *
 * Commits whose parents are outside the loaded page keep their lane reserved to
 * the end of the page rather than being dropped, so a partially loaded history
 * does not draw an edge that stops in mid-air.
 */
export function buildGraph(commits: Commit[]): Graph {
  // Lane slot -> oid the lane is currently waiting for. `null` means free.
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  // Commits already drawn. A lane may only be reserved for a commit still to
  // come: `git log` is not topologically ordered by default, so a parent can
  // appear *above* its child, and reserving a lane for it would leave a line
  // running to the bottom of the page for a commit that never arrives.
  const placed = new Set<string>();
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
    // A lane was already waiting for this commit exactly when a commit above
    // named it as a parent — which is also when a line arrives from above.
    const hasLineFromAbove = lanes.includes(commit.oid);
    const lane = claim(commit.oid);
    const before = lanes.map((waiting) => waiting);

    // The commit is placed, so its lane is free again until a parent takes it.
    lanes[lane] = null;

    const crossings: GraphEdge[] = [];
    const crossed = new Set<number>();
    /** Draws one line from this node down to `target`, at most once per lane. */
    const crossTo = (target: number): void => {
      // A commit may list the same parent twice (`commit-tree -p X -p X`), and
      // two identical paths are just one path drawn twice.
      if (target === lane || crossed.has(target)) return;
      crossed.add(target);
      crossings.push({ fromLane: lane, toLane: target, from: 'node', to: 'bottom' });
    };

    const [firstParent, ...otherParents] = commit.parents;
    if (firstParent !== undefined && !placed.has(firstParent)) {
      const waiting = lanes.indexOf(firstParent);
      if (waiting === -1) {
        // Nothing else expects that parent: it continues straight down here.
        lanes[lane] = firstParent;
      } else {
        // Another lane already holds the first parent. Rejoining it is what
        // keeps two lanes from waiting for the same commit — the state that
        // used to strand one of them, drawing a line to nothing.
        crossTo(waiting);
      }
    }
    // Every further parent reuses the lane already waiting for it, or opens
    // one. A parent already drawn above is skipped: the line would have to run
    // upwards, and no lane may be reserved for it.
    for (const parent of otherParents) if (!placed.has(parent)) crossTo(claim(parent));

    const edges: GraphEdge[] = [];
    for (let slot = 0; slot < Math.max(before.length, lanes.length); slot += 1) {
      if (slot === lane) {
        // The node's own lane. Each half is drawn only if something is there
        // to meet it: no line above a branch tip, none below a root commit.
        const below = lanes[lane] !== null && lanes[lane] !== undefined;
        if (hasLineFromAbove && below)
          edges.push({ fromLane: lane, toLane: lane, from: 'top', to: 'bottom' });
        else if (hasLineFromAbove)
          edges.push({ fromLane: lane, toLane: lane, from: 'top', to: 'node' });
        else if (below)
          edges.push({ fromLane: lane, toLane: lane, from: 'node', to: 'bottom' });
        continue;
      }

      // Any other lane either passes straight through the row or is opened by
      // one of the crossings above, which already draws its own bottom half.
      const wasActive = before[slot] !== null && before[slot] !== undefined;
      const isActive = lanes[slot] !== null && lanes[slot] !== undefined;
      if (wasActive && isActive)
        edges.push({ fromLane: slot, toLane: slot, from: 'top', to: 'bottom' });
    }
    edges.push(...crossings);

    // The widest *occupied* slot, not the count of occupied slots: a hole left
    // by a closed lane would otherwise under-report the width.
    const highest = lanes.reduce(
      (widest, waiting, slot) => (waiting === null ? widest : Math.max(widest, slot)),
      lane,
    );
    laneCount = Math.max(laneCount, highest + 1);
    placed.add(commit.oid);
    rows.push({
      oid: commit.oid,
      lane,
      edges,
      isMerge: commit.parents.length > 1,
    });
  }

  return { rows, laneCount: Math.max(laneCount, 1) };
}
