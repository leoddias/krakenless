import type { ReactNode } from 'react';
import type { GraphRow } from './graph';
import styles from './history.module.css';

/** Horizontal distance between lanes, in pixels. */
const LANE_WIDTH = 12;
const NODE_RADIUS = 3.5;

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
  const width = Math.max(laneCount, 1) * LANE_WIDTH;
  const nodeX = laneX(row.lane);
  const middle = rowHeight / 2;

  return (
    <svg
      className={styles.graph}
      width={width}
      height={rowHeight}
      viewBox={`0 0 ${width} ${rowHeight}`}
      aria-hidden="true"
      focusable="false"
    >
      {row.edges.map((edge) => (
        <path
          key={`${edge.fromLane}-${edge.toLane}`}
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
