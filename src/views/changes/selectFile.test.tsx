/**
 * Clicking a file in the working-tree panel narrows the diff panel to it.
 *
 * Both panels are rendered together here on purpose: the whole point of the
 * behaviour is that pressing something in one changes what the other shows, and
 * a test that only asserted on the store would pass while the diff below stayed
 * on the file it had fallen back to.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileDiff, RepoStatus, StatusEntry } from '../../git/types';
import { StoreProvider } from '../../state/hooks';
import { createStore, type Store } from '../../state/store';
import { ChangesView } from './ChangesView';
import { DiffView } from '../diff/DiffView';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

function entry(path: string, overrides: Partial<StatusEntry> = {}): StatusEntry {
  return {
    path,
    index: 'unmodified',
    worktree: 'modified',
    conflicted: false,
    ...overrides,
  };
}

function file(path: string): FileDiff {
  return {
    oldPath: path,
    newPath: path,
    kind: 'modified',
    binary: false,
    conflicted: false,
    side: 'unstaged',
    headerLines: [],
    hunks: [
      {
        header: '@@ -1,1 +1,1 @@',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [
          { kind: 'deleted', text: 'before', oldLine: 1 },
          { kind: 'added', text: `after in ${path}`, newLine: 1 },
        ],
      },
    ],
  };
}

function status(entries: StatusEntry[]): RepoStatus {
  return {
    branch: 'main',
    head: 'a'.repeat(40),
    detached: false,
    entries,
    hasConflicts: false,
  };
}

function renderPanels(prepare: (store: Store) => void = () => {}): Store {
  const store = createStore();
  store.dispatch({
    type: 'repo/opened',
    repo: { root: 'C:/repo', gitDir: 'C:/repo/.git', bare: false, empty: false },
  });
  store.dispatch({
    type: 'status/loaded',
    status: status([entry('src/a.ts'), entry('src/b.ts')]),
  });
  store.dispatch({ type: 'diff/loaded', files: [file('src/a.ts'), file('src/b.ts')] });
  prepare(store);
  render(
    <StoreProvider store={store}>
      <ChangesView />
      <DiffView />
    </StoreProvider>,
  );
  return store;
}

/** The clickable path inside the working-tree panel. */
function fileRow(path: string): HTMLElement {
  return within(screen.getByRole('region', { name: 'Changes' })).getByRole('button', {
    name: path,
  });
}

/** Diff bodies currently on screen, by their file name. */
function shownDiffs(): string[] {
  return screen.queryAllByRole('article').map((a) => a.getAttribute('aria-label') ?? '');
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({
    stdout: '',
    stderr: '',
    code: 0,
    timed_out: false,
    stdout_lossy: false,
  });
});

afterEach(cleanup);

describe('clicking a file in the working-tree panel', () => {
  it('narrows the diff to that file', () => {
    renderPanels();
    // The diff panel opens on the first file rather than on all of them, so
    // "narrowing" here is really "moving": one body, before and after.
    expect(shownDiffs()).toEqual(['src/a.ts']);
    fireEvent.click(fileRow('src/b.ts'));
    expect(shownDiffs()).toEqual(['src/b.ts']);
  });

  it('records the selection so both panels agree on it', () => {
    const store = renderPanels();
    fireEvent.click(fileRow('src/b.ts'));
    expect(store.getState().selection.path).toBe('src/b.ts');
  });

  it('marks the row the diff is showing', () => {
    renderPanels();
    fireEvent.click(fileRow('src/b.ts'));
    expect(fileRow('src/b.ts').getAttribute('aria-current')).toBe('true');
    expect(fileRow('src/a.ts').getAttribute('aria-current')).toBeNull();
  });

  it('moves the selection when another file is clicked', () => {
    renderPanels();
    fireEvent.click(fileRow('src/b.ts'));
    fireEvent.click(fileRow('src/a.ts'));
    expect(shownDiffs()).toEqual(['src/a.ts']);
  });

  it('agrees with the diff panel own file list', () => {
    renderPanels();
    fireEvent.click(fileRow('src/b.ts'));
    const list = screen.getByRole('navigation', { name: 'Changed files' });
    expect(
      within(list)
        .getByRole('button', { name: /src\/b\.ts/ })
        .getAttribute('aria-current'),
    ).toBe('true');
  });

  it('works for a staged file too', () => {
    renderPanels((store) => {
      store.dispatch({
        type: 'status/loaded',
        status: status([
          entry('src/a.ts', { index: 'modified', worktree: 'unmodified' }),
        ]),
      });
    });
    fireEvent.click(fileRow('src/a.ts'));
    expect(shownDiffs()).toEqual(['src/a.ts']);
  });
});

describe('when a commit is selected in the history', () => {
  it('switches back to the working tree, then shows the file', async () => {
    const store = renderPanels((s) => {
      s.dispatch({ type: 'selection/commit', oid: 'b'.repeat(40) });
      s.dispatch({ type: 'diff/loaded', files: [file('src/a.ts'), file('src/b.ts')] });
    });

    await act(async () => {
      fireEvent.click(fileRow('src/b.ts'));
    });

    // The commit selection is gone — a working-tree path means nothing in a
    // commit's diff — and the path survived the switch.
    expect(store.getState().selection.commitOid).toBeNull();
    expect(store.getState().selection.path).toBe('src/b.ts');
  });
});

describe('an untracked file', () => {
  it('shows the file from disk, every line added, not "wrong selection"', async () => {
    // `git diff` has nothing to say about a file it does not track, so the
    // panel reads it from disk and draws it the way git will once it is staged.
    invoke.mockImplementation(async (name: string) =>
      name === 'worktree_read'
        ? { text: 'export {};\n', stamp: '11-x', lossy: false }
        : { stdout: '', stderr: '', code: 0, timed_out: false, stdout_lossy: false },
    );
    renderPanels((store) => {
      store.dispatch({
        type: 'status/loaded',
        // Exactly what `parseUnlisted` produces for a `? path` record.
        status: status([entry('new.ts', { index: 'unmodified', worktree: 'untracked' })]),
      });
      store.dispatch({ type: 'diff/loaded', files: [file('src/a.ts')] });
    });

    fireEvent.click(fileRow('new.ts'));
    const article = await screen.findByRole('article', { name: 'new.ts' });
    expect(article).toHaveTextContent('export {};');
    expect(screen.queryByText(/not part of the current selection/)).toBeNull();
    expect(screen.queryByText('File not in this diff')).toBeNull();
  });

  it('still keeps "File not in this diff" for a stale selection', () => {
    renderPanels((store) => {
      store.dispatch({ type: 'selection/path', path: 'src/gone.ts' });
    });
    expect(screen.getByText('File not in this diff')).toBeTruthy();
  });
});
