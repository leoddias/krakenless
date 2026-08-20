import { useId, type ReactNode } from 'react';
import { avatarFill, initials } from './avatar';
import type { GraphAnchor, GraphEdge, GraphRow } from './graph';
import styles from './history.module.css';

/** Horizontal distance between lanes, in pixels. Wide enough for a badge. */
const LANE_WIDTH = 18;
const NODE_RADIUS = 3.5;
/** Radius of the author badge drawn in place of the node. */
const AVATAR_RADIUS = 8;

/**
 * Most rows a repository with many branches would otherwise reserve.
 *
 * `laneCount` is the widest point of the *whole* list, and every row reserves
 * it. A repository with a dozen branch tips would push the commit subject —
 * the one thing the row exists to show — off the end of every line. Lanes past
 * this are still drawn, just clipped.
 */
const MAX_RESERVED_LANES = 4;

function laneX(lane: number): number {
  return lane * LANE_WIDTH + LANE_WIDTH / 2;
}

/**
 * Vertical position of an edge's end inside the row.
 *
 * `top` and `bottom` are the row's exact boundaries, so a lane occupied in two
 * consecutive rows draws one unbroken line across them.
 */
function anchorY(anchor: GraphAnchor, rowHeight: number): number {
  if (anchor === 'top') return 0;
  if (anchor === 'bottom') return rowHeight;
  return rowHeight / 2;
}

/** The `d` of one edge: a straight run in a lane, or an S-curve between two. */
function edgePath(edge: GraphEdge, rowHeight: number): string {
  const x1 = laneX(edge.fromLane);
  const x2 = laneX(edge.toLane);
  const y1 = anchorY(edge.from, rowHeight);
  const y2 = anchorY(edge.to, rowHeight);
  if (edge.fromLane === edge.toLane) return `M ${x1} ${y1} L ${x2} ${y2}`;
  // A curve rather than a diagonal: where two lanes join, a straight line
  // crossing the node reads as passing through it. The control points sit
  // halfway down, so the curve leaves and arrives vertically and meets the
  // straight segments above and below without a kink.
  const middle = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${middle}, ${x2} ${middle}, ${x2} ${y2}`;
}

/**
 * One row's slice of the commit graph.
 *
 * Drawn as an SVG sized to the row, so the lines meet exactly across row
 * boundaries — a canvas or borders would drift as soon as the list scrolls.
 * It is `aria-hidden`: the row's own label already says what the commit is, and
 * a screen reader announcing "graphic" per row would be pure noise.
 */
export function GraphCell({
  row,
  laneCount,
  rowHeight,
  author,
  avatarUrl,
}: {
  row: GraphRow;
  laneCount: number;
  rowHeight: number;
  /**
   * Who wrote the commit. When given, the node is drawn as that author's
   * badge — initials on a colour derived from their identity, computed here
   * and never fetched (see `avatar.ts`).
   */
  author?: { name: string; email: string };
  /**
   * Picture to draw over the badge, when the user has opted into fetching one
   * (ADR-0019). It is layered *on top of* the derived badge rather than
   * replacing it, so a request that is blocked, offline or 404 leaves the
   * initials showing instead of a hole.
   */
  avatarUrl?: string | null;
}): ReactNode {
  const clipId = useId();
  const drawWidth = Math.max(laneCount, 1) * LANE_WIDTH;
  const width = Math.min(drawWidth, MAX_RESERVED_LANES * LANE_WIDTH);
  const nodeX = laneX(row.lane);
  const middle = rowHeight / 2;

  return (
    <svg
      className={styles.graph}
      width={width}
      height={rowHeight}
      viewBox={`0 0 ${drawWidth} ${rowHeight}`}
      preserveAspectRatio="xMinYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      {row.edges.map((edge, index) => (
        <path
          // Indexed: a commit can legitimately list the same parent twice
          // (`commit-tree -p X -p X`, or a filter-branch artefact), and a
          // lane-pair key would collide and drop one of the edges.
          key={index}
          className={styles.graphEdge}
          d={edgePath(edge, rowHeight)}
          fill="none"
        />
      ))}
      {author === undefined ? (
        <circle
          className={row.isMerge ? styles.graphNodeMerge : styles.graphNode}
          cx={nodeX}
          cy={middle}
          r={NODE_RADIUS}
        />
      ) : (
        <g>
          {/* The colour is a presentation attribute rather than a class: it is
              per-author data, not a style the sheet could know. */}
          <circle
            className={row.isMerge ? styles.graphAvatarMerge : styles.graphAvatar}
            cx={nodeX}
            cy={middle}
            r={AVATAR_RADIUS}
            fill={avatarFill(author.email, author.name)}
          />
          <text
            className={styles.graphInitials}
            x={nodeX}
            y={middle}
            textAnchor="middle"
            dominantBaseline="central"
          >
            {initials(author.name)}
          </text>
          {avatarUrl !== undefined && avatarUrl !== null && (
            <>
              <clipPath id={clipId}>
                <circle cx={nodeX} cy={middle} r={AVATAR_RADIUS} />
              </clipPath>
              <image
                className={styles.graphPhoto}
                href={avatarUrl}
                x={nodeX - AVATAR_RADIUS}
                y={middle - AVATAR_RADIUS}
                width={AVATAR_RADIUS * 2}
                height={AVATAR_RADIUS * 2}
                clipPath={`url(#${clipId})`}
                preserveAspectRatio="xMidYMid slice"
              />
            </>
          )}
        </g>
      )}
    </svg>
  );
}
