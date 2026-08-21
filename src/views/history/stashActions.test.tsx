/**
 * The stash side of the history panel, end to end: a stash arrives in the
 * commit list the way `git log --all` really reports it, and the panel has to
 * turn that into one row that says "stash" and offers the three stash actions.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Commit, RepoStatus, StashEntry } from '../../git/types';
import { StoreProvider } from '../../state/hooks';
import { createStore, type Store } from '../../state/store';
import { HistoryView } from './HistoryView';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const STASH_OID = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111';
const INDEX_OID = 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222';
const BASE_OID = 'cccc3333cccc3333cccc3333cccc3333cccc3333';
const STASH_ROW = /stash stash@/;

function raw(stdout = '') {
  return { stdout, stderr: '', code: 0, timed_out: false, stdout_lossy: false };
}

function commit(oid: string, parents: string[], subject: string): Commit {
  return {
    oid,
    shortOid: oid.slice(0, 7),
    parents,
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    authorDate: '2026-08-17T12:00:00Z',
    committerName: 'Ada',
    committerDate: '2026-08-17T12:00:00Z',
    subject,
    body: '',
    refs: [],
  };
}

/** Exactly the three rows `git log --all` reports for one stash. */
function commits(): Commit[] {
  return [
    commit(STASH_OID, [BASE_OID, INDEX_OID], 'On main: WIP on main'),
    commit(INDEX_OID, [BASE_OID], 'index on main: cccc333 feat(datapack)'),
    commit(BASE_OID, [], 'feat(datapack): give slime a self-heal defense spell'),
  ];
}

const ENTRY: StashEntry = {
  ref: 'stash@{0}',
  oid: STASH_OID,
  index: 0,
  message: 'On main: WIP on main',
  branch: 'main',
  date: '2026-08-17T12:00:00Z',
};

function status(overrides: Partial<RepoStatus> = {}): RepoStatus {
  return {
    branch: 'main',
    head: BASE_OID,
    detached: false,
    entries: [],
    hasConflicts: false,
    ...overrides,
  };
}

function openRepo(store: Store): void {
  store.dispatch({
    type: 'repo/opened',
    repo: { root: 'C:/repo', gitDir: 'C:/repo/.git', bare: false, empty: false },
  });
  store.dispatch({ type: 'commits/loaded', commits: commits() });
}

function renderHistory(
  overrides: { stashes?: StashEntry[]; status?: RepoStatus } = {},
): Store {
  const store = createStore();
  openRepo(store);
  store.dispatch({ type: 'status/loaded', status: overrides.status ?? status() });
  store.dispatch({ type: 'stashes/loaded', stashes: overrides.stashes ?? [ENTRY] });
  store.dispatch({ type: 'remotes/loaded', remotes: [] });
  render(
    <StoreProvider store={store}>
      <HistoryView />
    </StoreProvider>,
  );
  return store;
}

function rowNames(): string[] {
  return within(screen.getByRole('group', { name: 'Commits' }))
    .getAllByRole('button')
    .map((row) => row.getAttribute('aria-label') ?? '');
}

function openStashMenu(): HTMLElement {
  fireEvent.contextMenu(screen.getByRole('button', { name: STASH_ROW }));
  return screen.getByRole('menu', { name: /Actions for stash/ });
}

/** Only the commands this panel can start; selecting a row re-reads a diff. */
const WRITES = new Set(['stash', 'rev-parse']);

function invocations(): string[][] {
  return invoke.mock.calls
    .filter((call) => call[0] === 'git_run')
    .map((call) => call[1].args as string[])
    .filter((args) => WRITES.has(args[0] ?? ''));
}

beforeEach(() => {
  invoke.mockReset();
  // Every stash mutation first resolves the ref and compares it to the oid the
  // row was drawn from, so the happy path has to answer with that oid.
  invoke.mockResolvedValue(raw(`${STASH_OID}\n`));
});

afterEach(cleanup);

describe('a stash in the history', () => {
  it('collapses git bookkeeping to one row', () => {
    renderHistory();
    const names = rowNames();
    expect(names.some((name) => name.includes('index on main'))).toBe(false);
    expect(names.some((name) => name.includes('feat(datapack)'))).toBe(true);
  });

  it('says it is a stash, in the words a screen reader reads first', () => {
    renderHistory();
    expect(rowNames()[1]).toMatch(/^stash stash@\{0\}, WIP on main,/);
  });

  it('shows the stash message, not the commit subject git wrote', () => {
    renderHistory();
    const row = screen.getByRole('button', { name: STASH_ROW });
    expect(row.textContent).toContain('WIP on main');
    expect(row.textContent).not.toContain('On main: WIP on main');
  });

  it('carries a stash chip in the ref column', () => {
    renderHistory();
    const chip = screen
      .getByRole('button', { name: STASH_ROW })
      .querySelector('[data-ref-kind="stash"]');
    expect(chip?.textContent).toBe('stash@{0}');
  });

  it('does not attribute the row to an author', () => {
    renderHistory();
    expect(rowNames()[1]).not.toContain('Ada');
  });

  it('draws git bookkeeping as-is until the stash list has been read', () => {
    const store = createStore();
    openRepo(store);
    render(
      <StoreProvider store={store}>
        <HistoryView />
      </StoreProvider>,
    );
    expect(rowNames().some((name) => name.includes('index on main'))).toBe(true);
  });
});

describe('the stash context menu', () => {
  it('offers the stash actions instead of the commit ones', () => {
    renderHistory();
    const menu = openStashMenu();
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((entry) => entry.textContent),
    ).toEqual(['Apply Stash', 'Pop Stash', 'Delete Stash', 'Copy stash commit sha']);
  });

  it('still gives an ordinary commit the commit menu', () => {
    renderHistory();
    fireEvent.contextMenu(screen.getByRole('button', { name: /feat\(datapack\)/ }));
    expect(screen.getByRole('menu', { name: /Actions for commit/ })).toBeTruthy();
  });

  it('asks before applying, and runs nothing until answered', () => {
    renderHistory();
    openStashMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Apply Stash' }));
    expect(screen.getByRole('dialog', { name: /Apply this stash/ })).toBeTruthy();
    expect(invocations()).toEqual([]);
  });

  it('applies without removing the entry', async () => {
    renderHistory();
    openStashMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Apply Stash' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply Stash' }));
    });
    expect(invocations()).toContainEqual(['stash', 'apply', 'stash@{0}']);
  });

  it('pops, which applies and removes', async () => {
    renderHistory();
    openStashMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pop Stash' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pop Stash' }));
    });
    expect(invocations()).toContainEqual(['stash', 'pop', 'stash@{0}']);
  });

  it('deletes, and says how to get it back', async () => {
    const store = renderHistory();
    openStashMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete Stash' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete Stash' }));
    });
    expect(invocations()).toContainEqual(['stash', 'drop', 'stash@{0}']);
    expect(store.getState().notice?.undoHint).toBe(`git stash apply ${STASH_OID}`);
  });

  it('checks the ref still points where the row was drawn from', async () => {
    renderHistory();
    openStashMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pop Stash' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pop Stash' }));
    });
    expect(invocations()[0]).toEqual([
      'rev-parse',
      '--verify',
      '--quiet',
      'stash@{0}^{commit}',
    ]);
  });

  it('refuses to act when the list moved under the row', async () => {
    renderHistory();
    // Another stash was pushed since the list was read, so `stash@{0}` names a
    // different entry now.
    invoke.mockResolvedValue(raw('9999999999999999999999999999999999999999\n'));
    openStashMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pop Stash' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pop Stash' }));
    });
    expect(invocations()).not.toContainEqual(['stash', 'pop', 'stash@{0}']);
  });

  it('runs nothing when the question is cancelled', () => {
    renderHistory();
    openStashMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete Stash' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(invocations()).toEqual([]);
  });
});
