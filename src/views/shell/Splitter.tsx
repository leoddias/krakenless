/**
 * A draggable edge between two panels.
 *
 * It is a `separator` with a `tabindex`, which is the ARIA window-splitter
 * pattern: the same edge that responds to a drag responds to the arrow keys, so
 * the layout is not a mouse-only feature. It owns no size of its own — it
 * reports how far the pointer has travelled and lets the shell decide what that
 * means, because only the shell knows whether a pixel is a width or a share of
 * a column's height.
 *
 * Mouse events rather than pointer events: the drag has to keep tracking after
 * the pointer leaves the 5px hit area, which needs window-level listeners
 * either way, and mouse events behave identically in every environment this
 * runs in.
 *
 * A move is reported at most once per frame. A mouse fires movements faster
 * than the screen can show them — several per frame on a high-polling-rate
 * device — and each one used to become its own React render of the whole
 * window. The last position in a frame is the only one worth drawing, so the
 * rest are dropped rather than queued: a drag that renders behind the pointer
 * only falls further behind.
 */

import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import styles from './Splitter.module.css';

/** Pixels an arrow key moves the edge, and the same with Shift held. */
const STEP = 16;
const BIG_STEP = 64;

export interface SplitterProps {
  /** `vertical` is a vertical bar between two columns, per ARIA. */
  orientation: 'vertical' | 'horizontal';
  label: string;
  /** Current size of the panel this edge sizes, for assistive technology. */
  value: number;
  min: number;
  max: number;
  /** Snapshot the size being dragged; the deltas that follow are from here. */
  onDragStart: () => void;
  /** Pointer travel since the drag began, in pixels. */
  onDrag: (delta: number) => void;
  /** The drag finished, and the size is now worth remembering. */
  onDragEnd: () => void;
  /** A keyboard nudge, in pixels, already signed. */
  onNudge: (delta: number) => void;
}

export function Splitter({
  orientation,
  label,
  value,
  min,
  max,
  onDragStart,
  onDrag,
  onDragEnd,
  onNudge,
}: SplitterProps): ReactNode {
  const vertical = orientation === 'vertical';
  // Holds the teardown for an in-flight drag, so a component that unmounts
  // mid-drag does not leave listeners on the window.
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      stop.current?.();
    };
  }, []);

  const begin = useCallback(
    (event: {
      clientX: number;
      clientY: number;
      button: number;
      preventDefault: () => void;
    }) => {
      // Only the primary button drags; a right-click here is a context menu.
      if (event.button !== 0) return;
      event.preventDefault();
      const origin = vertical ? event.clientX : event.clientY;
      onDragStart();

      // The newest position seen this frame, and the frame that will report it.
      let latest = 0;
      let frame: number | null = null;

      const report = (): void => {
        frame = null;
        onDrag(latest);
      };

      const move = (moved: MouseEvent): void => {
        latest = (vertical ? moved.clientX : moved.clientY) - origin;
        // Already waiting on a frame: overwrite the position, do not queue a
        // second render for a pixel that will never be seen on its own.
        if (frame === null) frame = requestAnimationFrame(report);
      };
      const end = (): void => {
        // The drag ends on the last position the pointer reached, whether or
        // not its frame has run — otherwise a release between frames leaves
        // the panel a few pixels from where the user let go.
        if (frame !== null) {
          cancelAnimationFrame(frame);
          frame = null;
          onDrag(latest);
        }
        stop.current?.();
        onDragEnd();
      };

      stop.current = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', end);
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        // Text selection is suppressed for the duration of the drag only:
        // dragging across a commit list otherwise selects every row it crosses.
        document.body.style.removeProperty('user-select');
        document.body.style.removeProperty('cursor');
        stop.current = null;
      };

      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', end);
      document.body.style.setProperty('user-select', 'none');
      document.body.style.setProperty('cursor', vertical ? 'col-resize' : 'row-resize');
    },
    [onDrag, onDragEnd, onDragStart, vertical],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    const back = vertical ? 'ArrowLeft' : 'ArrowUp';
    const forward = vertical ? 'ArrowRight' : 'ArrowDown';
    if (event.key === back) {
      event.preventDefault();
      onNudge(-step);
      return;
    }
    if (event.key === forward) {
      event.preventDefault();
      onNudge(step);
    }
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      className={vertical ? styles.vertical : styles.horizontal}
      onMouseDown={begin}
      onKeyDown={onKeyDown}
    />
  );
}
