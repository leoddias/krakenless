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

    renderUntracked('data.bin');

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

describe('image preview', () => {
  const OID = 'c'.repeat(40);

  /** Answers each preview call with bytes that name the version asked for. */
  function answerPreviews(fail: (args: Record<string, string>) => boolean = () => false) {
    invoke.mockImplementation((command: string, args: Record<string, string>) => {
      if (command !== 'preview_blob' && command !== 'preview_worktree') {
        return Promise.reject(new Error(`unexpected ${command}`));
      }
      if (fail(args)) {
        return Promise.reject({
          kind: 'NotFound',
          message: `${args['spec'] ?? ''} is gone`,
        });
      }
      return Promise.resolve({
        base64: btoa(args['spec'] ?? args['path'] ?? ''),
        bytes: 2048,
      });
    });
  }

  function renderCommit(file: Partial<FileDiff>): void {
    const store = createStore();
    store.dispatch({
      type: 'repo/opened',
      repo: { root: 'C:/repo', gitDir: 'C:/repo/.git', bare: false, empty: false },
    });
    store.dispatch({ type: 'selection/commit', oid: OID });
    store.dispatch({
      type: 'diff/loaded',
      files: [
        {
          oldPath: 'img/a.png',
          newPath: 'img/a.png',
          kind: 'modified',
          binary: true,
          conflicted: false,
          side: 'commit',
          headerLines: [],
          hunks: [],
          ...file,
        },
      ],
    });
    render(
      <StoreProvider store={store}>
        <DiffView />
      </StoreProvider>,
    );
  }

  it("draws a commit's image beside its first parent's", async () => {
    answerPreviews();
    renderCommit({});

    const before = await screen.findByRole('img', { name: 'Before: img/a.png' });
    const after = await screen.findByRole('img', { name: 'After: img/a.png' });
    expect(invoke).toHaveBeenCalledWith('preview_blob', {
      repo: 'C:/repo',
      spec: `${OID}^:img/a.png`,
    });
    expect(invoke).toHaveBeenCalledWith('preview_blob', {
      repo: 'C:/repo',
      spec: `${OID}:img/a.png`,
    });
    expect(before).toHaveAttribute(
      'src',
      `data:image/png;base64,${btoa(`${OID}^:img/a.png`)}`,
    );
    expect(after).toHaveAttribute(
      'src',
      `data:image/png;base64,${btoa(`${OID}:img/a.png`)}`,
    );
    expect(screen.queryByText(/Binary file/)).toBeNull();
  });

  it('draws only the new version of an added image, and says it was added', async () => {
    answerPreviews();
    renderCommit({ kind: 'added' });

    await screen.findByRole('img', { name: 'Added: img/a.png' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('keeps the after when the before cannot be read', async () => {
    answerPreviews((args) => (args['spec'] ?? '').includes('^'));
    renderCommit({});

    await screen.findByRole('img', { name: 'After: img/a.png' });
    expect(
      await screen.findByText(/This version cannot be shown: .* is gone/),
    ).toBeInTheDocument();
  });

  it('reads the image again when a refresh brings new content at the same path', async () => {
    answerPreviews();
    const store = createStore();
    store.dispatch({
      type: 'repo/opened',
      repo: { root: 'C:/repo', gitDir: 'C:/repo/.git', bare: false, empty: false },
    });
    const edit = (index: string): FileDiff => ({
      oldPath: 'img/a.png',
      newPath: 'img/a.png',
      kind: 'modified',
      binary: true,
      conflicted: false,
      side: 'unstaged',
      headerLines: ['diff --git a/img/a.png b/img/a.png', index],
      hunks: [],
    });
    store.dispatch({
      type: 'diff/loaded',
      files: [edit('index 1111111..2222222 100644')],
    });
    render(
      <StoreProvider store={store}>
        <DiffView />
      </StoreProvider>,
    );
    await screen.findByRole('img', { name: 'After: img/a.png' });
    const reads = () =>
      invoke.mock.calls.filter(([command]) => command === 'preview_worktree').length;
    expect(reads()).toBe(1);

    await act(async () => {
      store.dispatch({
        type: 'diff/loaded',
        files: [edit('index 1111111..3333333 100644')],
      });
    });
    await waitFor(() => expect(reads()).toBe(2));
  });

  it('draws an untracked image from disk instead of refusing it as text', async () => {
    answerPreviews();
    renderUntracked('logo.png');

    await screen.findByRole('img', { name: 'Added: logo.png' });
    expect(invoke).toHaveBeenCalledWith('preview_worktree', {
      repo: 'C:/repo',
      path: 'logo.png',
    });
    expect(invoke).not.toHaveBeenCalledWith('worktree_read', expect.anything());
  });
});
