import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { undoDiscard, undoDiscards } from '../../state/actions';
import { StoreProvider } from '../../state/hooks';
import { createStore, type DiscardBackup, type Store } from '../../state/store';
import { DiscardBackups } from './DiscardBackups';

vi.mock('../../state/actions', () => ({
  undoDiscard: vi.fn().mockResolvedValue(undefined),
  undoDiscards: vi.fn().mockResolvedValue(undefined),
}));

const undoMock = vi.mocked(undoDiscard);
const undoAllMock = vi.mocked(undoDiscards);

function backup(overrides: Partial<DiscardBackup> = {}): DiscardBackup {
  return {
    path: 'src/a.ts',
    blobOid: 'a'.repeat(40),
    at: '2026-08-31T10:00:00.000Z',
    ...overrides,
  };
}

function renderBar(backups: DiscardBackup[]): Store {
  const store = createStore();
  for (const entry of backups) {
    store.dispatch({ type: 'discard/recorded', backup: entry });
  }
  render(
    <StoreProvider store={store}>
      <DiscardBackups />
    </StoreProvider>,
  );
  return store;
}

beforeEach(() => {
  undoMock.mockClear();
});

afterEach(cleanup);

describe('DiscardBackups', () => {
  it('shows nothing when nothing has been discarded', () => {
    renderBar([]);
    expect(screen.queryByRole('region', { name: 'Recent discards' })).toBeNull();
  });

  it('names the file and shows the oid that finds the backup', () => {
    // The oid is on screen, not hidden behind the button: if the app closes
    // with an entry still listed, this string is what makes the loose blob
    // findable again with `git cat-file`.
    renderBar([backup()]);

    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('aaaaaaaaaa')).toBeInTheDocument();
  });

  it('restores through the app rather than printing a shell command', () => {
    // `git cat-file -p <oid> > path` is byte-exact in cmd.exe and pwsh, but
    // Windows PowerShell 5.1 treats `>` as Out-File and rewrites the stream as
    // UTF-16LE with a BOM — a "recovery" that corrupts the file.
    const entry = backup();
    const store = renderBar([entry]);

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    expect(undoMock).toHaveBeenCalledWith(store, entry);
    expect(screen.queryByText(/cat-file/)).toBeNull();
  });

  it('survives the notice that announced it', () => {
    // The whole reason this lives in the store: a notice is replaced by the
    // very next operation, and the oid is the only handle on the discarded
    // work — no stash, no reflog, no commit.
    const store = renderBar([backup()]);
    act(() => {
      store.dispatch({
        type: 'notice',
        notice: { tone: 'info', message: 'something else' },
      });
    });

    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('keeps the newest discard first', () => {
    // Two discards, not one of two files: a different stamp each.
    renderBar([
      backup({
        path: 'older.ts',
        blobOid: 'b'.repeat(40),
        at: '2026-08-31T10:00:00.000Z',
      }),
      backup({
        path: 'newer.ts',
        blobOid: 'c'.repeat(40),
        at: '2026-08-31T10:05:00.000Z',
      }),
    ]);

    const rows = within(screen.getByRole('region', { name: 'Recent discards' }))
      .getAllByRole('listitem')
      .map((row) => row.textContent ?? '');
    expect(rows[0]).toContain('newer.ts');
  });

  it('dismissing only hides the row', () => {
    const store = renderBar([backup()]);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(store.getState().discards).toEqual([]);
    expect(undoMock).not.toHaveBeenCalled();
  });

  it('disables both buttons while a git command is running', () => {
    const store = renderBar([backup()]);
    act(() => {
      store.dispatch({ type: 'busy', busy: true });
    });

    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDisabled();
  });
});

describe('DiscardBackups — one row per discard', () => {
  const together = [
    backup({
      path: 'out/a.json',
      blobOid: 'a'.repeat(40),
      at: '2026-09-04T10:00:00.000Z',
    }),
    backup({
      path: 'out/b.json',
      blobOid: 'b'.repeat(40),
      at: '2026-09-04T10:00:00.000Z',
    }),
    backup({
      path: 'out/c.json',
      blobOid: 'c'.repeat(40),
      at: '2026-09-04T10:00:00.000Z',
    }),
  ];

  it('folds files that share a stamp into one row with one Undo', () => {
    // "Discard all" over a build directory is thousands of files; a row each
    // would push the repository off the screen.
    renderBar(together);

    expect(screen.getByText('3 files discarded together')).toBeInTheDocument();
    expect(screen.queryByText('out/a.json')).toBeNull();
    expect(screen.getByRole('button', { name: 'Undo all' })).toBeInTheDocument();
  });

  it('restores the whole discard from its row', () => {
    const store = renderBar(together);

    fireEvent.click(screen.getByRole('button', { name: 'Undo all' }));

    expect(undoAllMock).toHaveBeenCalledTimes(1);
    const [, passed] = undoAllMock.mock.calls[0] ?? [];
    expect((passed as DiscardBackup[]).map((entry) => entry.path)).toEqual([
      'out/c.json',
      'out/b.json',
      'out/a.json',
    ]);
    expect(store.getState().discards).toHaveLength(3);
  });

  it('opens to the file-by-file buttons', () => {
    renderBar(together);

    fireEvent.click(screen.getByRole('button', { name: /3 files discarded together/ }));

    const list = screen.getByRole('list', { name: '3 files discarded together' });
    expect(within(list).getByText('out/a.json')).toBeInTheDocument();
    fireEvent.click(within(list).getAllByRole('button', { name: 'Undo' })[0]!);
    expect(undoMock).toHaveBeenCalledTimes(1);
  });

  it('dismisses the whole discard at once, keeping the blobs', () => {
    const store = renderBar(together);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss all' }));

    expect(store.getState().discards).toEqual([]);
    expect(screen.queryByRole('region', { name: 'Recent discards' })).toBeNull();
  });

  it('keeps a discard of one file as a plain row', () => {
    renderBar([backup({ at: '2026-09-04T11:00:00.000Z' }), ...together]);

    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('3 files discarded together')).toBeInTheDocument();
  });
});
