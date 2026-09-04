import { describe, expect, it } from 'vitest';
import type { FileDiff } from '../../git/types';
import { buildFileTree, directoryPaths, type TreeNode } from './fileTree';
import type { FilePlan } from './renderPlan';

function plan(path: string, oldPath = path): FilePlan {
  const file: FileDiff = {
    oldPath,
    newPath: path,
    kind: oldPath === path ? 'modified' : 'renamed',
    binary: false,
    conflicted: false,
    side: 'unstaged',
    headerLines: [],
    hunks: [],
  };
  return { file, key: `unstaged:${path}`, total: 0, added: 0, deleted: 0, visible: 0 };
}

/** The tree as indented lines, which is what a reader compares by eye. */
function outline(nodes: TreeNode[], depth = 0): string[] {
  return nodes.flatMap((node) =>
    node.kind === 'dir'
      ? [`${'  '.repeat(depth)}${node.name}/`, ...outline(node.children, depth + 1)]
      : [`${'  '.repeat(depth)}${node.name}`],
  );
}

describe('buildFileTree', () => {
  it('groups files under the directories they share', () => {
    const tree = buildFileTree([plan('src/a.ts'), plan('src/b.ts'), plan('README.md')]);

    expect(outline(tree)).toEqual(['src/', '  a.ts', '  b.ts', 'README.md']);
  });

  it('collapses a chain of single-child directories into one row', () => {
    // Three nested rows for `src/views/history` would indent the file name off
    // the edge of a narrow column and say nothing the one row does not.
    const tree = buildFileTree([
      plan('src/views/history/HistoryView.tsx'),
      plan('src/views/history/graph.ts'),
    ]);

    // Case-insensitive, as a file manager sorts: `graph` before `HistoryView`.
    expect(outline(tree)).toEqual([
      'src/views/history/',
      '  graph.ts',
      '  HistoryView.tsx',
    ]);
    expect(tree[0]?.kind === 'dir' && tree[0].path).toBe('src/views/history');
  });

  it('stops collapsing where the paths part ways', () => {
    const tree = buildFileTree([
      plan('src/views/history/a.ts'),
      plan('src/views/diff/b.ts'),
      plan('src/git/c.ts'),
    ]);

    expect(outline(tree)).toEqual([
      'src/',
      '  git/',
      '    c.ts',
      '  views/',
      '    diff/',
      '      b.ts',
      '    history/',
      '      a.ts',
    ]);
  });

  it('does not collapse a directory that has a file of its own', () => {
    const tree = buildFileTree([plan('src/index.ts'), plan('src/lib/util.ts')]);

    expect(outline(tree)).toEqual(['src/', '  lib/', '    util.ts', '  index.ts']);
  });

  it('sorts directories before files, each alphabetically, whatever order git used', () => {
    const tree = buildFileTree([
      plan('z.ts'),
      plan('b/y.ts'),
      plan('a.ts'),
      plan('a/x.ts'),
    ]);

    expect(outline(tree)).toEqual(['a/', '  x.ts', 'b/', '  y.ts', 'a.ts', 'z.ts']);
  });

  it('places a rename at its new path', () => {
    const tree = buildFileTree([plan('new/name.ts', 'old/name.ts')]);

    expect(outline(tree)).toEqual(['new/', '  name.ts']);
  });

  it('keeps the plan on the file row, so the panel can select and count it', () => {
    const only = plan('src/a.ts');
    const tree = buildFileTree([only]);
    const dir = tree[0];
    const file = dir?.kind === 'dir' ? dir.children[0] : undefined;

    expect(file?.kind === 'file' && file.plan).toBe(only);
  });

  it('is empty for an empty diff', () => {
    expect(buildFileTree([])).toEqual([]);
  });
});

describe('directoryPaths', () => {
  it('lists every directory row, collapsed names included', () => {
    const tree = buildFileTree([
      plan('src/views/a.ts'),
      plan('src/git/b.ts'),
      plan('c.ts'),
    ]);

    expect(directoryPaths(tree)).toEqual(['src', 'src/git', 'src/views']);
  });
});
