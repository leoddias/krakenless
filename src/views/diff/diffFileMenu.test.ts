import { describe, expect, it } from 'vitest';
import type { FileDiff } from '../../git/types';
import { buildDiffFileMenu, fileName, type DiffFileMenuItem } from './diffFileMenu';

function file(overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    oldPath: 'src/views/a.ts',
    newPath: 'src/views/a.ts',
    kind: 'modified',
    binary: false,
    conflicted: false,
    side: 'commit',
    headerLines: [],
    hunks: [],
    ...overrides,
  };
}

function item(sections: DiffFileMenuItem[][], id: string): DiffFileMenuItem {
  const found = sections.flat().find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no item ${id}`);
  return found;
}

describe('fileName', () => {
  it('takes the last segment', () => {
    expect(fileName('videos/out/thumbs/m2.png')).toBe('m2.png');
  });
  it('returns a top-level path whole', () => {
    expect(fileName('README.md')).toBe('README.md');
  });
});

describe('buildDiffFileMenu', () => {
  it('offers reveal, editor and the three copies for a file on disk', () => {
    const menu = buildDiffFileMenu({ file: file(), root: 'C:/repo' });
    expect(item(menu, 'reveal')).toMatchObject({
      disabled: null,
      action: { kind: 'reveal', path: 'C:/repo/src/views/a.ts' },
    });
    expect(item(menu, 'edit')).toMatchObject({
      disabled: null,
      action: { kind: 'edit', path: 'src/views/a.ts' },
    });
    expect(item(menu, 'copy-relative').action).toEqual({
      kind: 'copy',
      text: 'src/views/a.ts',
      what: 'path',
    });
    expect(item(menu, 'copy-absolute').action).toEqual({
      kind: 'copy',
      text: 'C:/repo/src/views/a.ts',
      what: 'full path',
    });
    expect(item(menu, 'copy-name').action).toEqual({
      kind: 'copy',
      text: 'a.ts',
      what: 'file name',
    });
  });

  it('keeps a backslash root in backslashes', () => {
    const menu = buildDiffFileMenu({ file: file(), root: 'C:\\repo' });
    expect(item(menu, 'copy-absolute').action).toMatchObject({
      text: 'C:\\repo\\src\\views\\a.ts',
    });
  });

  it('acts on the new path of a rename — the one that exists', () => {
    const menu = buildDiffFileMenu({
      file: file({ kind: 'renamed', oldPath: 'old/a.ts', newPath: 'new/b.ts' }),
      root: '/repo',
    });
    expect(item(menu, 'reveal').action).toMatchObject({ path: '/repo/new/b.ts' });
    expect(item(menu, 'copy-relative').action).toMatchObject({ text: 'new/b.ts' });
  });

  it('greys reveal and editor for a deleted file, with the reason, but still copies', () => {
    const menu = buildDiffFileMenu({ file: file({ kind: 'deleted' }), root: '/repo' });
    for (const id of ['reveal', 'edit']) {
      const entry = item(menu, id);
      expect(entry.action).toBeUndefined();
      expect(entry.disabled).toMatch(/deletes the file/);
    }
    expect(item(menu, 'copy-relative').disabled).toBeNull();
    expect(item(menu, 'copy-absolute').disabled).toBeNull();
  });

  it('words the deleted reason for the working tree too', () => {
    const menu = buildDiffFileMenu({
      file: file({ kind: 'deleted', side: 'unstaged' }),
      root: '/repo',
    });
    expect(item(menu, 'reveal').disabled).toMatch(/nothing on disk/);
  });

  it('without a working tree, only the relative copies run', () => {
    const menu = buildDiffFileMenu({ file: file(), root: null });
    expect(item(menu, 'reveal').disabled).not.toBeNull();
    expect(item(menu, 'edit').disabled).not.toBeNull();
    expect(item(menu, 'copy-absolute').disabled).not.toBeNull();
    expect(item(menu, 'copy-absolute').action).toBeUndefined();
    expect(item(menu, 'copy-relative').disabled).toBeNull();
    expect(item(menu, 'copy-name').disabled).toBeNull();
  });
});
