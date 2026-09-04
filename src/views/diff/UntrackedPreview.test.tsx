import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileDiff, RepoStatus } from '../../git/types';
import { StoreProvider } from '../../state/hooks';
import { createStore, type Store } from '../../state/store';
import { DiffView } from './DiffView';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

function statusWith(path: string): RepoStatus {
  return {
    branch: 'main',
    head: 'a'.repeat(40),
    detached: false,
    ahead: 0,
    behind: 0,
    entries: [{ path, index: 'untracked', worktree: 'untracked', conflicted: false }],
    hasConflicts: false,
  };
}

/** What `worktree_read` answers with: the file, as the editor would get it. */
function contents(text: string, lossy = false) {
  return { text, stamp: `${String(text.length)}-x`, lossy };
}

function renderUntracked(path: string, options: { files?: FileDiff[] } = {}): Store {
  const store = createStore();
  store.dispatch({
    type: 'repo/opened',
    repo: { root: 'C:/repo', gitDir: 'C:/repo/.git', bare: false, empty: false },
  });
  store.dispatch({ type: 'status/loaded', status: statusWith(path) });
  store.dispatch({ type: 'diff/loaded', files: options.files ?? [] });
  store.dispatch({ type: 'selection/path', path });
  render(
    <StoreProvider store={store}>
      <DiffView />
    </StoreProvider>,
  );
  return store;
}

beforeEach(() => {
  invoke.mockReset();
});

afterEach(cleanup);

describe('an untracked file in the diff panel', () => {
  it('shows the file from disk, every line added', async () => {
    // The screenshot: ".graphifyignore is not tracked by git yet … Stage it
    // to see its contents as a diff." The contents are right there on disk.
    invoke.mockResolvedValue(contents('node_modules\ndist\n'));

    renderUntracked('.graphifyignore');

    const article = await screen.findByRole('article', { name: '.graphifyignore' });
    expect(invoke).toHaveBeenCalledWith('worktree_read', {
      repo: 'C:/repo',
      path: '.graphifyignore',
    });
    const rows = [...article.querySelectorAll<HTMLElement>('[data-kind]')];
    expect(rows.map((row) => [row.dataset.kind, row.dataset.newLine])).toEqual([
      ['added', '1'],
      ['added', '2'],
    ]);
    expect(article).toHaveTextContent('node_modules');
    expect(article).toHaveTextContent('dist');
    expect(within(article).getByText('Added')).toBeInTheDocument();
  });

  it('offers no hunk buttons: there is no index entry to stage against', async () => {
    invoke.mockResolvedValue(contents('a\n'));

    renderUntracked('new.txt');

    const article = await screen.findByRole('article', { name: 'new.txt' });
    expect(within(article).queryByRole('button', { name: /Stage hunk/ })).toBeNull();
    expect(within(article).queryByRole('button', { name: /Discard hunk/ })).toBeNull();
    // Editing is fine — the file is on disk, and that is what the editor edits.
    expect(within(article).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('is shown even when the rest of the diff is empty', async () => {
    // A working tree whose only changes are new files has an empty `git diff`,
    // which used to read as "No changes" over a file the user just clicked.
    invoke.mockResolvedValue(contents('only\n'));

    renderUntracked('only.txt', { files: [] });

    expect(await screen.findByRole('article', { name: 'only.txt' })).toBeInTheDocument();
    expect(screen.queryByText('No changes')).toBeNull();
  });

  it('says why when the file cannot be shown as text', async () => {
    // A binary refused by the same door the editor uses, with the same reason.
    invoke.mockResolvedValue(contents('\ufffd\ufffd', true));

    renderUntracked('logo.png');

    await waitFor(() => {
      expect(screen.getByText('Nothing to diff yet')).toBeInTheDocument();
    });
    expect(screen.getByText(/cannot be shown here/)).toBeInTheDocument();
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('draws an empty file as an empty diff, not a blank', async () => {
    invoke.mockResolvedValue(contents(''));

    renderUntracked('empty.txt');

    const article = await screen.findByRole('article', { name: 'empty.txt' });
    expect(article.querySelectorAll('[data-kind]')).toHaveLength(0);
    // The ordinary file block explains an empty added file in its own words.
    expect(article).toHaveTextContent(/empty|no content|nothing/i);
  });

  it('re-reads when another untracked file is picked', async () => {
    invoke.mockResolvedValue(contents('first\n'));
    const store = renderUntracked('a.txt');
    await screen.findByRole('article', { name: 'a.txt' });

    invoke.mockResolvedValue(contents('second\n'));
    act(() => {
      store.dispatch({
        type: 'status/loaded',
        status: {
          ...statusWith('a.txt'),
          entries: [
            {
              path: 'a.txt',
              index: 'untracked',
              worktree: 'untracked',
              conflicted: false,
            },
            {
              path: 'b.txt',
              index: 'untracked',
              worktree: 'untracked',
              conflicted: false,
            },
          ],
        },
      });
      store.dispatch({ type: 'selection/path', path: 'b.txt' });
    });

    const article = await screen.findByRole('article', { name: 'b.txt' });
    expect(article).toHaveTextContent('second');
    expect(article).not.toHaveTextContent('first');
  });
});
