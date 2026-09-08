import { describe, expect, it } from 'vitest';
import { buildPathTree, directoryPaths, visiblePaths, type PathNode } from './pathTree';

/** The item is deliberately not a diff or a status entry: the shape is generic. */
interface Item {
  path: string;
  from?: string;
}

function item(path: string, from?: string): Item {
  return from === undefined ? { path } : { path, from };
}

function tree(items: Item[]): PathNode<Item>[] {
  return buildPathTree(items, (entry) => entry.path);
}

/** The tree as indented lines, which is what a reader compares by eye. */
function outline(nodes: PathNode<Item>[], depth = 0): string[] {
  return nodes.flatMap((node) =>
    node.kind === 'dir'
      ? [`${'  '.repeat(depth)}${node.name}/`, ...outline(node.children, depth + 1)]
      : [`${'  '.repeat(depth)}${node.name}`],
  );
}

describe('buildPathTree', () => {
  it('groups files under the directories they share', () => {
    expect(
      outline(tree([item('src/a.ts'), item('src/b.ts'), item('README.md')])),
    ).toEqual(['src/', '  a.ts', '  b.ts', 'README.md']);
  });

  it('collapses a chain of single-child directories into one row', () => {
    // Three nested rows for `src/views/history` would indent the file name off
    // the edge of a narrow column and say nothing the one row does not.
    const nodes = tree([
      item('src/views/history/HistoryView.tsx'),
      item('src/views/history/graph.ts'),
    ]);

    // Case-insensitive, as a file manager sorts: `graph` before `HistoryView`.
    expect(outline(nodes)).toEqual([
      'src/views/history/',
      '  graph.ts',
      '  HistoryView.tsx',
    ]);
    expect(nodes[0]?.kind === 'dir' && nodes[0].path).toBe('src/views/history');
  });

  it('stops collapsing where the paths part ways', () => {
    const nodes = tree([
      item('src/views/history/a.ts'),
      item('src/views/diff/b.ts'),
      item('src/git/c.ts'),
    ]);

    expect(outline(nodes)).toEqual([
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
    expect(outline(tree([item('src/index.ts'), item('src/lib/util.ts')]))).toEqual([
      'src/',
      '  lib/',
      '    util.ts',
      '  index.ts',
    ]);
  });

  it('sorts directories before files, each alphabetically, whatever order git used', () => {
    const nodes = tree([item('z.ts'), item('b/y.ts'), item('a.ts'), item('a/x.ts')]);

    expect(outline(nodes)).toEqual(['a/', '  x.ts', 'b/', '  y.ts', 'a.ts', 'z.ts']);
  });

  it('files an item wherever the caller says, which for a rename is its new path', () => {
    const renamed = item('new/name.ts', 'old/name.ts');

    expect(outline(tree([renamed]))).toEqual(['new/', '  name.ts']);
  });

  it('keeps the item and its full path on the file row', () => {
    // The row has to carry both: the item is what the panel counts and draws,
    // and the path is what an action on the row names — the row's own label is
    // just the last segment, which names nothing on its own.
    const only = item('src/a.ts');
    const dir = tree([only])[0];
    const file = dir?.kind === 'dir' ? dir.children[0] : undefined;

    expect(file?.kind === 'file' && file.item).toBe(only);
    expect(file?.kind === 'file' && file.path).toBe('src/a.ts');
  });

  it('is empty for an empty list', () => {
    expect(tree([])).toEqual([]);
  });
});

describe('directoryPaths', () => {
  it('lists every directory row, collapsed names included', () => {
    const nodes = tree([item('src/views/a.ts'), item('src/git/b.ts'), item('c.ts')]);

    expect(directoryPaths(nodes)).toEqual(['src', 'src/git', 'src/views']);
  });
});

describe('visiblePaths', () => {
  const nodes = tree([item('src/git/a.ts'), item('src/views/b.ts'), item('README.md')]);

  it('reads the rows top to bottom, which is what a shift-range measures', () => {
    expect(visiblePaths(nodes, new Set())).toEqual([
      'src/git/a.ts',
      'src/views/b.ts',
      'README.md',
    ]);
  });

  it('leaves out what a folded directory is hiding', () => {
    // A range that ran through a folded directory would select files the user
    // can see nothing of, and the next bulk action would act on them.
    expect(visiblePaths(nodes, new Set(['src/git']))).toEqual([
      'src/views/b.ts',
      'README.md',
    ]);
  });

  it('hides everything under a folded parent, however deep', () => {
    expect(visiblePaths(nodes, new Set(['src']))).toEqual(['README.md']);
  });
});
