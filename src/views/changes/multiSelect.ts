/**
 * Selecting several files in one of the working-tree lists.
 *
 * Staging changes one file at a time is fine until a refactor touches thirty,
 * and then the only options were thirty clicks or "Stage all" — which is not
 * the same thing, and is how unrelated work ends up in a commit.
 *
 * The rules are the ones every file list has used for decades, and users have
 * a right to expect them exactly:
 *
 * - a plain click selects one file and becomes the anchor;
 * - shift-click selects everything between the anchor and the clicked row,
 *   inclusive, and leaves the anchor where it was, so shift-clicking again
 *   grows or shrinks the same range rather than starting a new one;
 * - ctrl or cmd click adds or removes one file and moves the anchor to it.
 *
 * Pure, and separate from the panel, because "which rows are selected" is the
 * kind of thing that goes subtly wrong — a range built from the wrong end, an
 * anchor left pointing at a file that has since been staged — and subtly wrong
 * here means staging something the user did not look at.
 */

export interface Selection {
  /** Selected paths. Order is the list's, not the order they were clicked. */
  readonly paths: ReadonlySet<string>;
  /** Where a shift-range measures from; `null` when there is nothing to measure. */
  readonly anchor: string | null;
}

export interface ClickIntent {
  path: string;
  /** Shift held: extend from the anchor. */
  shift: boolean;
  /** Ctrl or Cmd held: add or remove this one. */
  toggle: boolean;
}

export const EMPTY_SELECTION: Selection = { paths: new Set(), anchor: null };

/** Selects exactly one path, which becomes the anchor. */
export function selectOnly(path: string): Selection {
  return { paths: new Set([path]), anchor: path };
}

/**
 * The paths between `a` and `b` in `order`, inclusive, in either direction.
 *
 * Returns an empty array when either end is missing rather than guessing at a
 * range — a range measured from a row that is not there is not a range.
 */
export function rangeBetween(order: readonly string[], a: string, b: string): string[] {
  const from = order.indexOf(a);
  const to = order.indexOf(b);
  if (from === -1 || to === -1) return [];
  const [start, end] = from <= to ? [from, to] : [to, from];
  return order.slice(start, end + 1);
}

/**
 * The selection a click produces.
 *
 * `order` is the list as drawn, which is what a shift-range means: the rows
 * between these two *on screen*, not in some other ordering.
 */
export function nextSelection(
  order: readonly string[],
  current: Selection,
  intent: ClickIntent,
): Selection {
  if (!order.includes(intent.path)) return current;

  if (intent.shift) {
    // No anchor — or one that has since left the list, which happens the
    // moment a selected file is staged — makes this a plain click. Silently
    // selecting from the top of the list instead would be a range the user
    // never asked for, over files they may not have scrolled to.
    const anchor =
      current.anchor !== null && order.includes(current.anchor) ? current.anchor : null;
    if (anchor === null) return selectOnly(intent.path);
    return { paths: new Set(rangeBetween(order, anchor, intent.path)), anchor };
  }

  if (intent.toggle) {
    const paths = new Set(current.paths);
    if (paths.has(intent.path)) paths.delete(intent.path);
    else paths.add(intent.path);
    // The anchor follows the click even when the click deselected: the next
    // shift-click measures from where the user last pointed.
    return { paths, anchor: intent.path };
  }

  return selectOnly(intent.path);
}

/**
 * Drops selected paths that are no longer in the list.
 *
 * The list changes under the selection constantly — staging moves a file to
 * the other section, a fetch or an editor changes what is modified at all — and
 * a selection holding paths that are gone would let a bulk action be built from
 * rows nobody can see. Returns the same object when nothing changed, so it is
 * safe to call on every render.
 */
export function pruneSelection(order: readonly string[], current: Selection): Selection {
  const kept = [...current.paths].filter((path) => order.includes(path));
  const anchor =
    current.anchor !== null && order.includes(current.anchor) ? current.anchor : null;
  if (kept.length === current.paths.size && anchor === current.anchor) return current;
  return { paths: new Set(kept), anchor };
}

/** Selected paths in the list's own order, which is the order actions use. */
export function selectedInOrder(
  order: readonly string[],
  selection: Selection,
): string[] {
  return order.filter((path) => selection.paths.has(path));
}
