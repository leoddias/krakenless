/**
 * The saved panel and column sizes, and the machinery for dragging them.
 *
 * The size on screen comes from the config while nothing is being dragged, and
 * from a local draft while something is: writing every mouse-move to disk would
 * be hundreds of file writes per drag. The draft is discarded when the drag
 * ends and the result is saved once. A failed save costs the user a panel size,
 * never the session, so it is swallowed rather than surfaced.
 *
 * Shared by every panel with an edge to drag — the shell, the history table's
 * columns, the file list beside a diff — so that all of them remember sizes the
 * same way and none can write a size the others would refuse to read.
 */

import { useCallback, useRef, useState, type RefObject } from 'react';
import { clampLayout, type AppConfig, type LayoutConfig } from '../../config/schema';
import { saveConfig } from '../../config/store';
import { useAppState } from '../../state/hooks';
import { publishConfig } from '../../state/stores';

/**
 * Hands a changed config to every open tab and writes it to disk.
 *
 * For a preference changed by a click in a panel — a column width, the shape
 * of a list — rather than through the settings form, which has its own save
 * button and its own way of reporting failure. Here the change is already on
 * screen; failing to remember it is not worth an alert over the repository.
 */
export function rememberConfig(config: AppConfig): void {
  publishConfig(config);
  void saveConfig(config).catch(() => {
    // Already applied on screen; see above.
  });
}

export interface LayoutHandle {
  layout: LayoutConfig;
  /** Snapshot the layout; the deltas that follow are applied to that. */
  beginDrag: () => void;
  /** Draw a layout, clamped, without saving it. */
  setLayout: (next: LayoutConfig) => void;
  /** Save what is on screen and drop the draft. */
  endDrag: () => void;
  /** The layout as of `beginDrag`, so a drag cannot compound its own output. */
  startRef: RefObject<LayoutConfig>;
}

export function useLayout(): LayoutHandle {
  const config = useAppState((state) => state.config);
  const [draft, setDraft] = useState<LayoutConfig | null>(null);
  const layout = draft ?? config.layout;
  const startRef = useRef<LayoutConfig>(layout);

  const beginDrag = useCallback(() => {
    startRef.current = layout;
  }, [layout]);

  const setLayout = useCallback((next: LayoutConfig) => {
    setDraft(clampLayout(next));
  }, []);

  const endDrag = useCallback(() => {
    setDraft((current) => {
      if (current === null) return null;
      // Every open tab, not just this one: the panel sizes are one setting.
      rememberConfig({ ...config, layout: current });
      return null;
    });
  }, [config]);

  return { layout, beginDrag, setLayout, endDrag, startRef };
}

/**
 * The three handlers one draggable edge needs, for a size that lives at
 * `read`/`write` inside the layout.
 *
 * `direction` is which way the size grows when the pointer moves right or
 * down: `1` for an edge on a panel's trailing side, `-1` for one on its
 * leading side, where dragging right makes the panel *narrower*. Every edge in
 * the app used to spell these three closures out by hand, and the sign was the
 * part that got copied wrong.
 */
export function edgeHandlers(
  handle: LayoutHandle,
  read: (layout: LayoutConfig) => number,
  write: (layout: LayoutConfig, value: number) => LayoutConfig,
  direction: 1 | -1 = 1,
): {
  onDragStart: () => void;
  onDrag: (delta: number) => void;
  onDragEnd: () => void;
  onNudge: (delta: number) => void;
} {
  const { layout, beginDrag, setLayout, endDrag, startRef } = handle;
  return {
    onDragStart: beginDrag,
    onDrag: (delta) =>
      setLayout(write(startRef.current, read(startRef.current) + direction * delta)),
    onDragEnd: endDrag,
    onNudge: (delta) => {
      beginDrag();
      setLayout(write(layout, read(layout) + direction * delta));
      endDrag();
    },
  };
}
