import { describe, expect, it, vi } from 'vitest';
import {
  activeTab,
  closeRepoTab,
  openRepoTab,
  sameRepo,
  tabFor,
  type RepoTab,
  type Workspace,
} from './tabs';

/** A tab's store is opaque here; a label is enough to tell them apart. */
type Store = string;

function tab(id: string, root: string): RepoTab<Store> {
  return { id, root, store: `store-${id}` };
}

function workspace(tabs: RepoTab<Store>[], activeId: string | null): Workspace<Store> {
  return { tabs, activeId };
}

const EMPTY: Workspace<Store> = { tabs: [], activeId: null };

describe('sameRepo', () => {
  it('sees through the separator the path happened to arrive with', () => {
    expect(sameRepo('C:/repos/app', 'C:\\repos\\app')).toBe(true);
  });

  it('ignores case, because the filesystems this ships on do', () => {
    // Two tabs on one repository means two watchers and two ideas of what is
    // staged, both writing to the same index.
    expect(sameRepo('C:/repos/App', 'c:/repos/app')).toBe(true);
  });

  it('ignores a trailing separator', () => {
    expect(sameRepo('C:/repos/app/', 'C:/repos/app')).toBe(true);
  });

  it('does not merge two different repositories', () => {
    expect(sameRepo('C:/repos/app', 'C:/repos/app2')).toBe(false);
    expect(sameRepo('C:/repos/app', 'C:/repos/app/sub')).toBe(false);
  });
});

describe('openRepoTab', () => {
  it('opens a repository that is not open yet', () => {
    const next = openRepoTab(EMPTY, 'C:/repos/app', () => tab('1', 'C:/repos/app'));

    expect(next.tabs.map((t) => t.root)).toEqual(['C:/repos/app']);
    expect(next.activeId).toBe('1');
  });

  it('activates the tab a repository already has instead of opening a second', () => {
    const start = workspace([tab('1', 'C:/repos/app'), tab('2', 'C:/repos/other')], '2');
    const make = vi.fn(() => tab('3', 'C:/repos/app'));

    const next = openRepoTab(start, 'C:\\repos\\App', make);

    expect(make).not.toHaveBeenCalled();
    expect(next.tabs).toHaveLength(2);
    expect(next.activeId).toBe('1');
  });

  it('adds new tabs at the end, so the strip does not reorder itself', () => {
    let next = openRepoTab(EMPTY, 'C:/a', () => tab('1', 'C:/a'));
    next = openRepoTab(next, 'C:/b', () => tab('2', 'C:/b'));
    next = openRepoTab(next, 'C:/c', () => tab('3', 'C:/c'));

    expect(next.tabs.map((t) => t.id)).toEqual(['1', '2', '3']);
    expect(next.activeId).toBe('3');
  });
});

describe('closeRepoTab', () => {
  const three = workspace([tab('1', 'C:/a'), tab('2', 'C:/b'), tab('3', 'C:/c')], '2');

  it('moves to the right-hand neighbour when the active tab closes', () => {
    const next = closeRepoTab(three, '2');
    expect(next.tabs.map((t) => t.id)).toEqual(['1', '3']);
    expect(next.activeId).toBe('3');
  });

  it('falls back to the left when the last tab closes', () => {
    const next = closeRepoTab(workspace(three.tabs, '3'), '3');
    expect(next.activeId).toBe('2');
  });

  it('leaves you where you are when another tab closes', () => {
    const next = closeRepoTab(three, '1');
    expect(next.activeId).toBe('2');
  });

  it('goes home when the only tab closes', () => {
    const next = closeRepoTab(workspace([tab('1', 'C:/a')], '1'), '1');
    expect(next.tabs).toEqual([]);
    expect(next.activeId).toBeNull();
  });

  it('ignores a tab that is not open', () => {
    expect(closeRepoTab(three, 'gone')).toBe(three);
  });
});

describe('activeTab', () => {
  it('is the tab on screen', () => {
    const start = workspace([tab('1', 'C:/a'), tab('2', 'C:/b')], '2');
    expect(activeTab(start)?.root).toBe('C:/b');
  });

  it('is nothing at all on the home screen', () => {
    expect(activeTab(workspace([tab('1', 'C:/a')], null))).toBeUndefined();
  });
});

describe('tabFor', () => {
  it('finds a repository however its path was spelled', () => {
    const tabs = [tab('1', 'C:/repos/app')];
    expect(tabFor(tabs, 'c:\\repos\\app')?.id).toBe('1');
    expect(tabFor(tabs, 'C:/repos/elsewhere')).toBeUndefined();
  });
});
