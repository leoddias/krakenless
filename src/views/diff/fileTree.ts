/**
 * The changed files of a diff arranged as the directories they live in.
 *
 * A flat list of paths is the honest view of a small change and an unreadable
 * one of a large refactor: forty rows starting with `src/views/history/` say
 * nothing until the eye reaches the end of each. The tree says it once.
 *
 * Pure, and separate from the panel, so the two rules that decide what a row
 * shows can be asserted directly: directories with one child are collapsed
 * into their child (`src/views/history` is one row, not three), and files sort
 * after directories, each group alphabetically, so the shape does not depend on
 * the order git happened to list the files in.
 */

import type { FilePlan } from './renderPlan';

export type TreeNode =
  | {
      kind: 'dir';
      /** The segment(s) shown on the row; `a/b` after a single-child collapse. */
      name: string;
      /** Full path from the repository root, for keys and for collapsing. */
      path: string;
      children: TreeNode[];
    }
  | {
      kind: 'file';
      /** The file's own name — what the row shows once its folder has been. */
      name: string;
      plan: FilePlan;
    };

interface Building {
  dirs: Map<string, Building>;
  files: FilePlan[];
}

function newDir(): Building {
  return { dirs: new Map(), files: [] };
}

/** Builds the tree for a diff's files. Renames are placed at their new path. */
export function buildFileTree(plans: readonly FilePlan[]): TreeNode[] {
  const root = newDir();
  for (const plan of plans) {
    const segments = plan.file.newPath.split('/').filter((part) => part.length > 0);
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let child = node.dirs.get(segment);
      if (child === undefined) {
        child = newDir();
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.push(plan);
  }
  return finish(root, '');
}

function finish(node: Building, prefix: string): TreeNode[] {
  const dirs: TreeNode[] = [...node.dirs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, child]) => collapse(name, child, prefix));
  const files: TreeNode[] = node.files
    .slice()
    .sort((a, b) => a.file.newPath.localeCompare(b.file.newPath))
    .map((plan) => ({
      kind: 'file',
      name: plan.file.newPath.slice(plan.file.newPath.lastIndexOf('/') + 1),
      plan,
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
function collapse(name: string, node: Building, prefix: string): TreeNode {
  let label = name;
  let current = node;
  while (current.files.length === 0 && current.dirs.size === 1) {
    const [[childName, child]] = [...current.dirs.entries()] as [[string, Building]];
    label = `${label}/${childName}`;
    current = child;
  }
  const path = prefix.length === 0 ? label : `${prefix}/${label}`;
  return { kind: 'dir', name: label, path, children: finish(current, path) };
}

/** Every directory path in the tree, for "collapse all" and its inverse. */
export function directoryPaths(nodes: readonly TreeNode[]): string[] {
  return nodes.flatMap((node) =>
    node.kind === 'dir' ? [node.path, ...directoryPaths(node.children)] : [],
  );
}
