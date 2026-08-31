import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { undoDiscard } from '../../state/actions';
import { StoreProvider } from '../../state/hooks';
import { createStore, type DiscardBackup, type Store } from '../../state/store';
import { DiscardBackups } from './DiscardBackups';

vi.mock('../../state/actions', () => ({
  undoDiscard: vi.fn().mockResolvedValue(undefined),
}));

const undoMock = vi.mocked(undoDiscard);

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
    renderBar([
      backup({ path: 'older.ts', blobOid: 'b'.repeat(40) }),
      backup({ path: 'newer.ts', blobOid: 'c'.repeat(40) }),
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
