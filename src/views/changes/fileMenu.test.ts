import { describe, expect, it } from 'vitest';
import type { FileState, StatusEntry } from '../../git/types';
import {
  absolutePath,
  buildFileMenu,
  deleteCost,
  deleteQuestion,
  type FileMenuItem,
  type FileMenuSection,
} from './fileMenu';

function entry(path: string, over: Partial<StatusEntry> = {}): StatusEntry {
  return {
    path,
    index: 'unmodified' as FileState,
    worktree: 'modified' as FileState,
    conflicted: false,
    ...over,
  };
}

function find(sections: FileMenuSection[], id: string): FileMenuItem {
  const item = sections.flat().find((candidate) => candidate.id === id);
  if (item === undefined) throw new Error(`no item ${id}`);
  return item;
}

function menu(
  entries: StatusEntry[],
  over: { root?: string | null; busy?: boolean; discardable?: string[] } = {},
): FileMenuSection[] {
  return buildFileMenu({
    entries,
    root: over.root === undefined ? 'C:/repos/app' : over.root,
    busy: over.busy ?? false,
    discardable: new Set(over.discardable ?? entries.map((item) => item.path)),
  });
}

describe('absolutePath', () => {
  it('joins onto a root that uses forward slashes', () => {
    expect(absolutePath('C:/repos/app', 'src/a.ts')).toBe('C:/repos/app/src/a.ts');
  });

  it('never mixes separators when the root uses backslashes', () => {
    // `C:\repos\app/src/a.ts` opens nothing on Windows and pastes badly
    // everywhere else.
    expect(absolutePath('C:\\repos\\app', 'src/a.ts')).toBe('C:\\repos\\app\\src\\a.ts');
  });

  it('does not double the separator on a root that ends in one', () => {
    expect(absolutePath('C:/repos/app/', 'a.ts')).toBe('C:/repos/app/a.ts');
    expect(absolutePath('/home/me/app/', 'a.ts')).toBe('/home/me/app/a.ts');
  });

  it('keeps a path with spaces and unicode intact', () => {
    expect(absolutePath('/home/me/app', 'my notes/ação.md')).toBe(
      '/home/me/app/my notes/ação.md',
    );
  });
});

describe('buildFileMenu', () => {
  it('offers every item on an ordinary unstaged file', () => {
    const sections = menu([entry('src/a.ts')]);

    for (const id of ['discard', 'delete', 'reveal', 'copy-relative', 'copy-absolute']) {
      expect(find(sections, id).disabled, id).toBeNull();
    }
    expect(find(sections, 'discard').action).toEqual({
      kind: 'discard',
      paths: ['src/a.ts'],
    });
    expect(find(sections, 'reveal').action).toEqual({
      kind: 'reveal',
      path: 'C:/repos/app/src/a.ts',
    });
  });

  it('refuses to discard a path with nothing unstaged, and says why', () => {
    // The staged list shows files whose only change is in the index. Discard
    // there would either do nothing or, worse, take the staged snapshot.
    const sections = menu([entry('src/a.ts', { index: 'modified' })], {
      discardable: [],
    });

    const item = find(sections, 'discard');
    expect(item.disabled).toMatch(/no unstaged changes/i);
    expect(item.action).toBeUndefined();
  });

  it('refuses both writes on a conflicted path', () => {
    const sections = menu([
      entry('src/a.ts', { conflicted: true, worktree: 'unmerged' }),
    ]);

    expect(find(sections, 'discard').disabled).toMatch(/unmerged/i);
    expect(find(sections, 'discard').action).toBeUndefined();
  });

  it('discards only the rows that have something to discard', () => {
    // A right-click on a selection where one file is staged-only must not put
    // that file in the confirmation: it is not going to be touched.
    const sections = menu([entry('a.ts'), entry('b.ts', { index: 'modified' })], {
      discardable: ['a.ts'],
    });

    expect(find(sections, 'discard').action).toEqual({
      kind: 'discard',
      paths: ['a.ts'],
    });
  });

  it('names both sides of a rename for a discard', () => {
    // Discarding only the new path leaves the old one staged as a deletion,
    // which is a working tree with neither file in it.
    const sections = menu([entry('new.ts', { worktree: 'renamed', origPath: 'old.ts' })]);

    expect(find(sections, 'discard').action).toEqual({
      kind: 'discard',
      paths: ['old.ts', 'new.ts'],
    });
  });

  it('deletes and reveals only the path that exists on disk', () => {
    const sections = menu([entry('new.ts', { worktree: 'renamed', origPath: 'old.ts' })]);

    expect(find(sections, 'delete').action).toEqual({
      kind: 'delete',
      paths: ['new.ts'],
    });
    expect(find(sections, 'reveal').action).toEqual({
      kind: 'reveal',
      path: 'C:/repos/app/new.ts',
    });
  });

  it('refuses to delete or reveal a file git already reports deleted', () => {
    const sections = menu([entry('gone.ts', { worktree: 'deleted' })]);

    expect(find(sections, 'delete').disabled).toMatch(/not on disk/i);
    expect(find(sections, 'reveal').disabled).toMatch(/not on disk/i);
  });

  it('reveals one file at a time and says so for a multi-file selection', () => {
    const sections = menu([entry('a.ts'), entry('b.ts')]);

    expect(find(sections, 'reveal').disabled).toMatch(/one file at a time/i);
    expect(find(sections, 'reveal').action).toBeUndefined();
  });

  it('copies several paths one per line, relative and absolute', () => {
    const sections = menu([entry('a.ts'), entry('src/b.ts')]);

    expect(find(sections, 'copy-relative').action).toEqual({
      kind: 'copy',
      text: 'a.ts\nsrc/b.ts',
      what: 'path',
    });
    expect(find(sections, 'copy-absolute').action).toEqual({
      kind: 'copy',
      text: 'C:/repos/app/a.ts\nC:/repos/app/src/b.ts',
      what: 'full path',
    });
  });

  it('counts the files in the labels of a multi-file menu', () => {
    // A right-click on one row of a twelve-row selection acts on all twelve;
    // the label is the only place that is said before something happens.
    const sections = menu([entry('a.ts'), entry('b.ts'), entry('c.ts')]);

    expect(find(sections, 'discard').label).toBe('Discard changes in 3 files');
    expect(find(sections, 'delete').label).toBe('Delete 3 files from disk');
  });

  it('offers nothing that writes while another git command is running', () => {
    const sections = menu([entry('a.ts')], { busy: true });

    expect(find(sections, 'discard').disabled).toMatch(/already running/i);
    expect(find(sections, 'delete').disabled).toMatch(/already running/i);
    // Reading is always safe: these two never touch the repository.
    expect(find(sections, 'copy-relative').disabled).toBeNull();
    expect(find(sections, 'reveal').disabled).toBeNull();
  });

  it('disables what needs the repository root when it is not known', () => {
    const sections = menu([entry('a.ts')], { root: null });

    expect(find(sections, 'reveal').disabled).toMatch(/not known/i);
    expect(find(sections, 'copy-absolute').disabled).toMatch(/not known/i);
    expect(find(sections, 'copy-absolute').action).toBeUndefined();
    // The relative path needs no root, and is the one git speaks.
    expect(find(sections, 'copy-relative').disabled).toBeNull();
  });

  it('keeps the destructive items apart from the harmless ones', () => {
    // The renderer draws a rule between sections. Copy sitting next to Delete
    // is how a slip becomes a deletion.
    const sections = menu([entry('a.ts')]);

    expect(sections[0]?.map((item) => item.id)).toEqual(['discard', 'delete']);
    expect(sections[1]?.map((item) => item.id)).toEqual([
      'reveal',
      'copy-relative',
      'copy-absolute',
    ]);
  });
});

describe('deleteQuestion', () => {
  it('names the file when there is one, and the count when there are more', () => {
    expect(deleteQuestion(['src/a.ts'])).toBe('Delete src/a.ts from disk?');
    expect(deleteQuestion(['a.ts', 'b.ts'])).toBe('Delete 2 files from disk?');
  });
});

describe('deleteCost', () => {
  it('separates files git could give back from files that exist nowhere else', () => {
    const cost = deleteCost([
      entry('tracked.ts'),
      entry('new.ts', { worktree: 'untracked' }),
    ]);

    expect(cost.tracked).toEqual(['tracked.ts']);
    expect(cost.untracked).toEqual(['new.ts']);
  });
});
