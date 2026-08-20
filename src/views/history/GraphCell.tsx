import type { ReactNode } from 'react';
import type { GraphRow } from './graph';
import styles from './history.module.css';

/** Horizontal distance between lanes, in pixels. */
const LANE_WIDTH = 10;
const NODE_RADIUS = 3.5;

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
}: {
  row: GraphRow;
  laneCount: number;
  rowHeight: number;
}): ReactNode {
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
          d={
            edge.fromLane === edge.toLane
              ? `M ${laneX(edge.fromLane)} 0 L ${laneX(edge.fromLane)} ${rowHeight}`
              : // A curve rather than a diagonal: where two lanes join, a
                // straight line crossing the node reads as passing through it.
                `M ${laneX(edge.fromLane)} ${middle} C ${laneX(edge.fromLane)} ${rowHeight}, ${laneX(edge.toLane)} ${middle}, ${laneX(edge.toLane)} ${rowHeight}`
          }
          fill="none"
        />
      ))}
      <circle
        className={row.isMerge ? styles.graphNodeMerge : styles.graphNode}
        cx={nodeX}
        cy={middle}
        r={NODE_RADIUS}
      />
    </svg>
  );
}
