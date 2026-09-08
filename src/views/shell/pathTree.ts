/**
 * A list of repository paths arranged as the directories they live in.
 *
 * A flat list of paths is the honest view of a small change and an unreadable
 * one of a large refactor: forty rows starting with `src/views/history/` say
 * nothing until the eye reaches the end of each. The tree says it once.
 *
 * Generic over what a row carries, because the two lists that need it hold
 * different things — a diff's file plans, the working tree's status entries —
 * and the rules that decide the *shape* are the same for both. One
 * implementation also means one place where the shape can be wrong.
 *
 * Pure, and separate from the panels, so those rules can be asserted directly:
 * directories with one child are collapsed into their child (`src/views/diff`
 * is one row, not three), and files sort after directories, each group
 * alphabetically, so the shape does not depend on the order git listed them in.
 */

export type PathNode<T> =
  | {
      kind: 'dir';
      /** The segment(s) shown on the row; `a/b` after a single-child collapse. */
      name: string;
      /** Full path from the repository root, for keys and for collapsing. */
      path: string;
      children: PathNode<T>[];
    }
  | {
      kind: 'file';
      /** The file's own name — what the row shows once its folder has been. */
      name: string;
      /** Full path from the repository root: what an action on the row names. */
      path: string;
      item: T;
    };

interface Building<T> {
  dirs: Map<string, Building<T>>;
  files: { path: string; item: T }[];
}

function newDir<T>(): Building<T> {
  return { dirs: new Map(), files: [] };
}

/**
 * Builds the tree for a list of items.
 *
 * `pathOf` decides which path an item is filed under — its *new* path for a
 * rename, which is where the user will look for it.
 */
export function buildPathTree<T>(
  items: readonly T[],
  pathOf: (item: T) => string,
): PathNode<T>[] {
  const root = newDir<T>();
  for (const item of items) {
    const path = pathOf(item);
    const segments = path.split('/').filter((part) => part.length > 0);
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let child = node.dirs.get(segment);
      if (child === undefined) {
        child = newDir<T>();
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.push({ path, item });
  }
  return finish(root, '');
}

function finish<T>(node: Building<T>, prefix: string): PathNode<T>[] {
  const dirs: PathNode<T>[] = [...node.dirs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, child]) => collapse(name, child, prefix));
  const files: PathNode<T>[] = node.files
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(({ path, item }) => ({
      kind: 'file',
      name: path.slice(path.lastIndexOf('/') + 1),
      path,
      item,
    }));
  return [...dirs, ...files];
}

/**
 * A directory whose only content is one directory is shown as one row.
 *
 * `src/views/history` with nothing else under `src` or `src/views` reads as
 * three nested rows otherwise, each indenting the next, until a deep path
 * pushes its own file name off the edge of a narrow column.
 */
function collapse<T>(name: string, node: Building<T>, prefix: string): PathNode<T> {
  let label = name;
  let current = node;
  while (current.files.length === 0 && current.dirs.size === 1) {
    const [[childName, child]] = [...current.dirs.entries()] as [[string, Building<T>]];
    label = `${label}/${childName}`;
    current = child;
  }
  const path = prefix.length === 0 ? label : `${prefix}/${label}`;
  return { kind: 'dir', name: label, path, children: finish(current, path) };
}

/** Every directory path in the tree, for "collapse all" and its inverse. */
export function directoryPaths<T>(nodes: readonly PathNode<T>[]): string[] {
  return nodes.flatMap((node) =>
    node.kind === 'dir' ? [node.path, ...directoryPaths(node.children)] : [],
  );
}

/**
 * The file paths of the tree in the order the rows are drawn, skipping what is
 * folded away.
 *
 * This is what a shift-click range means: the rows between these two *on
 * screen*. Measuring a range in the flat order instead would, in a tree, select
 * files the user can see nothing of — including files inside a folded
 * directory, which is how a bulk action ends up touching work nobody looked at.
 */
export function visiblePaths<T>(
  nodes: readonly PathNode<T>[],
  folded: ReadonlySet<string>,
): string[] {
  return nodes.flatMap((node) =>
    node.kind === 'file'
      ? [node.path]
      : folded.has(node.path)
        ? []
        : visiblePaths(node.children, folded),
  );
}
