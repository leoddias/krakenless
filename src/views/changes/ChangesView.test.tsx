import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoStatus, StatusEntry } from '../../git/types';
import { commitStaged, discard, stage, unstage } from '../../state/actions';
import { StoreProvider } from '../../state/hooks';
import { createStore, type Store } from '../../state/store';
import { ChangesView } from './ChangesView';

vi.mock('../../state/actions', () => ({
  stage: vi.fn(),
  unstage: vi.fn(),
  discard: vi.fn(),
  commitStaged: vi.fn(),
}));

const stageMock = vi.mocked(stage);
const unstageMock = vi.mocked(unstage);
const discardMock = vi.mocked(discard);
const commitMock = vi.mocked(commitStaged);

function entry(overrides: Partial<StatusEntry> & { path: string }): StatusEntry {
  return {
    index: 'unmodified',
    worktree: 'unmodified',
    conflicted: false,
    ...overrides,
  };
}

function statusOf(entries: StatusEntry[]): RepoStatus {
  return {
    branch: 'main',
    head: 'a'.repeat(40),
    detached: false,
    ahead: 0,
    behind: 0,
    entries,
    hasConflicts: entries.some((e) => e.conflicted),
  };
}

function renderChanges(prepare: (store: Store) => void = () => {}): Store {
  const store = createStore();
  prepare(store);
  render(
    <StoreProvider store={store}>
      <ChangesView />
    </StoreProvider>,
  );
  return store;
}

function renderWithEntries(entries: StatusEntry[]): Store {
  return renderChanges((store) =>
    store.dispatch({ type: 'status/loaded', status: statusOf(entries) }),
  );
}

function section(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

beforeEach(() => {
  stageMock.mockReset().mockResolvedValue(undefined);
  unstageMock.mockReset().mockResolvedValue(undefined);
  discardMock.mockReset().mockResolvedValue({ stashLabel: 'krakenless: discarded now' });
  commitMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  // Testing Library only auto-cleans with `globals: true`, which this project
  // does not use.
  cleanup();
});

describe('panel states', () => {
  it('invites the user to open a repository while idle', () => {
    renderChanges();
    expect(
      screen.getByText('Open a repository to see its working-tree changes.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Staged' })).not.toBeInTheDocument();
  });

  it('announces loading', () => {
    renderChanges((store) => store.dispatch({ type: 'status/loading' }));
    expect(screen.getByRole('status')).toHaveTextContent('Loading changes…');
  });

  it('shows the error message and its kind', () => {
    renderChanges((store) =>
      store.dispatch({
        type: 'status/failed',
        message: 'fatal: not a git repository',
        kind: 'not-a-repository',
      }),
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Could not read the working tree');
    expect(alert).toHaveTextContent('fatal: not a git repository');
    expect(alert).toHaveTextContent('not-a-repository');
  });

  it('says the working tree is clean when there is nothing to show', () => {
    renderWithEntries([]);
    expect(screen.getByText('Working tree clean')).toBeInTheDocument();
  });

  it('shows a clean tree as an empty commit box, not a usable one', () => {
    renderWithEntries([]);
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();
  });
});

describe('list split', () => {
  it('separates staged from unstaged and puts untracked files in unstaged', () => {
    renderWithEntries([
      entry({ path: 'staged.ts', index: 'modified' }),
      entry({ path: 'edited.ts', worktree: 'modified' }),
      entry({ path: 'brand-new.ts', worktree: 'untracked' }),
    ]);

    const staged = within(section('Staged')).getAllByRole('listitem');
    const unstaged = within(section('Unstaged')).getAllByRole('listitem');

    expect(staged).toHaveLength(1);
    expect(staged[0]).toHaveTextContent('staged.ts');
    expect(unstaged.map((row) => row.textContent)).toEqual([
      expect.stringContaining('edited.ts'),
      expect.stringContaining('brand-new.ts'),
    ]);
    expect(within(section('Unstaged')).getByText('Untracked')).toBeInTheDocument();
  });

  it('renders a rename as old → new with its state label', () => {
    renderWithEntries([entry({ path: 'new.ts', origPath: 'old.ts', index: 'renamed' })]);

    expect(within(section('Staged')).getByText('old.ts → new.ts')).toBeInTheDocument();
    expect(within(section('Staged')).getByText('Renamed')).toBeInTheDocument();
  });

  it('counts the entries in each section heading', () => {
    renderWithEntries([
      entry({ path: 'a.ts', index: 'modified' }),
      entry({ path: 'b.ts', worktree: 'modified' }),
      entry({ path: 'c.ts', worktree: 'modified' }),
    ]);

    expect(screen.getByRole('heading', { name: 'Staged (1)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Unstaged (2)' })).toBeInTheDocument();
  });
});

describe('staging', () => {
  it('stages one row', () => {
    const store = renderWithEntries([entry({ path: 'a b.ts', worktree: 'modified' })]);

    fireEvent.click(screen.getByRole('button', { name: 'Stage a b.ts' }));

    expect(stageMock).toHaveBeenCalledWith(store, ['a b.ts']);
  });

  it('unstages one row', () => {
    const store = renderWithEntries([entry({ path: 'a.ts', index: 'modified' })]);

    fireEvent.click(screen.getByRole('button', { name: 'Unstage a.ts' }));

    expect(unstageMock).toHaveBeenCalledWith(store, ['a.ts']);
  });

  it('stages a rename by its current path, not its display text', () => {
    const store = renderWithEntries([
      entry({ path: 'new.ts', origPath: 'old.ts', worktree: 'renamed' }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Stage old.ts → new.ts' }));

    expect(stageMock).toHaveBeenCalledWith(store, ['new.ts']);
  });

  it('stages all unstaged paths at once', () => {
    const store = renderWithEntries([
      entry({ path: 'a.ts', worktree: 'modified' }),
      entry({ path: 'b.ts', worktree: 'untracked' }),
      entry({ path: 'staged.ts', index: 'modified' }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Stage all' }));

    expect(stageMock).toHaveBeenCalledWith(store, ['a.ts', 'b.ts']);
  });

  it('unstages all staged paths at once', () => {
    const store = renderWithEntries([
      entry({ path: 'a.ts', index: 'added' }),
      entry({ path: 'b.ts', index: 'deleted' }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Unstage all' }));

    expect(unstageMock).toHaveBeenCalledWith(store, ['a.ts', 'b.ts']);
  });

  it('disables bulk actions when the list is empty', () => {
    renderWithEntries([entry({ path: 'a.ts', worktree: 'modified' })]);

    expect(screen.getByRole('button', { name: 'Unstage all' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stage all' })).toBeEnabled();
  });
});

describe('discard confirmation', () => {
  function renderOneUnstaged(): Store {
    return renderWithEntries([entry({ path: 'a.ts', worktree: 'modified' })]);
  }

  it('does not discard on the first click', () => {
    renderOneUnstaged();

    fireEvent.click(screen.getByRole('button', { name: 'Discard a.ts' }));

    expect(discardMock).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog', { name: 'Confirm discard' })).toBeVisible();
  });

  it('names exactly which paths and how many are affected', () => {
    renderWithEntries([
      entry({ path: 'a.ts', worktree: 'modified' }),
      entry({ path: 'b.ts', worktree: 'untracked' }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Discard all' }));

    const dialog = screen.getByRole('alertdialog', { name: 'Confirm discard' });
    expect(dialog).toHaveTextContent('Discard changes to 2 files?');
    expect(within(dialog).getByText('a.ts')).toBeInTheDocument();
    expect(within(dialog).getByText('b.ts')).toBeInTheDocument();
  });

  it('cancels without discarding anything', () => {
    renderOneUnstaged();
    fireEvent.click(screen.getByRole('button', { name: 'Discard a.ts' }));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(discardMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('focuses the safe choice so a stray Enter cannot discard', () => {
    renderOneUnstaged();
    fireEvent.click(screen.getByRole('button', { name: 'Discard a.ts' }));

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('discards only after the confirmation button', async () => {
    const store = renderOneUnstaged();
    fireEvent.click(screen.getByRole('button', { name: 'Discard a.ts' }));

    fireEvent.click(screen.getByRole('button', { name: 'Discard 1 file' }));

    expect(discardMock).toHaveBeenCalledWith(store, ['a.ts']);
    await screen.findByText(/git stash pop/);
  });

  it('keeps the recovery message on screen with the stash label', async () => {
    discardMock.mockResolvedValue({ stashLabel: 'krakenless: discarded 2026-08-20' });
    renderOneUnstaged();
    fireEvent.click(screen.getByRole('button', { name: 'Discard a.ts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard 1 file' }));

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('krakenless: discarded 2026-08-20');
    expect(notice).toHaveTextContent('git stash pop');
    expect(within(notice).getByText('a.ts')).toBeInTheDocument();

    // It stays until the user dismisses it: a message that vanishes takes the
    // only recovery instructions with it.
    expect(screen.getByRole('status')).toBeInTheDocument();
    fireEvent.click(within(notice).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/git stash pop/)).not.toBeInTheDocument();
  });

  it('never claims a recovery that did not happen', async () => {
    discardMock.mockResolvedValue(null);
    renderOneUnstaged();
    fireEvent.click(screen.getByRole('button', { name: 'Discard a.ts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard 1 file' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Nothing was discarded');
    expect(screen.queryByText(/git stash pop/)).not.toBeInTheDocument();
  });

  it('reports a failed discard as changes still present', async () => {
    discardMock.mockRejectedValue(new Error('fatal: cannot save the current worktree'));
    renderOneUnstaged();
    fireEvent.click(screen.getByRole('button', { name: 'Discard a.ts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard 1 file' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('still in the working tree');
    expect(alert).toHaveTextContent('fatal: cannot save the current worktree');
  });
});

describe('conflicted entries', () => {
  const conflicted = entry({
    path: 'merge.ts',
    index: 'unmerged',
    worktree: 'unmerged',
    conflicted: true,
    conflictKind: 'UU',
  });

  it('lists them apart from ordinary changes', () => {
    renderWithEntries([conflicted, entry({ path: 'a.ts', worktree: 'modified' })]);

    expect(within(section('Conflicted')).getByText('merge.ts')).toBeInTheDocument();
    expect(within(section('Staged')).queryByText('merge.ts')).not.toBeInTheDocument();
    expect(within(section('Unstaged')).queryByText('merge.ts')).not.toBeInTheDocument();
  });

  it('offers no stage or discard button for them', () => {
    renderWithEntries([conflicted]);

    expect(within(section('Conflicted')).queryByRole('button')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Stage merge.ts' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Discard merge.ts' }),
    ).not.toBeInTheDocument();
  });

  it('explains the conflict and why staging is withheld', () => {
    renderWithEntries([conflicted]);

    const region = section('Conflicted');
    expect(region).toHaveTextContent('Both sides changed this file.');
    expect(region).toHaveTextContent('Resolve these files in your editor first.');
  });

  it('does not let a conflicted path alone enable committing', () => {
    renderWithEntries([conflicted]);

    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();
  });
});

describe('commit box', () => {
  function typeMessage(text: string): void {
    fireEvent.change(screen.getByLabelText('Commit message'), {
      target: { value: text },
    });
  }

  it('stays disabled while nothing is staged', () => {
    renderWithEntries([entry({ path: 'a.ts', worktree: 'modified' })]);
    typeMessage('feat: something');

    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();
    expect(screen.getByText('Stage at least one file to commit.')).toBeInTheDocument();
  });

  it('stays disabled while the message is blank', () => {
    renderWithEntries([entry({ path: 'a.ts', index: 'modified' })]);
    typeMessage('   ');

    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();
    expect(screen.getByText('Write a commit message to commit.')).toBeInTheDocument();
  });

  it('commits the staged index and clears the message', async () => {
    const store = renderWithEntries([entry({ path: 'a.ts', index: 'modified' })]);
    typeMessage('feat: add a thing');

    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));

    expect(commitMock).toHaveBeenCalledWith(store, {
      message: 'feat: add a thing',
      amend: false,
    });
    await vi.waitFor(() => {
      expect(screen.getByLabelText('Commit message')).toHaveValue('');
    });
  });

  it('keeps the message when the commit fails', async () => {
    commitMock.mockRejectedValue(new Error('fatal: no name configured'));
    renderWithEntries([entry({ path: 'a.ts', index: 'modified' })]);
    typeMessage('feat: add a thing');

    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Commit failed: fatal: no name configured');
    expect(screen.getByLabelText('Commit message')).toHaveValue('feat: add a thing');
  });

  it('warns that amending rewrites the last commit', () => {
    renderWithEntries([entry({ path: 'a.ts', index: 'modified' })]);

    fireEvent.click(screen.getByLabelText('Amend the last commit'));

    expect(screen.getByText(/Amending rewrites the last commit/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Amend commit' })).toBeInTheDocument();
  });

  it('passes amend through to the action', () => {
    const store = renderWithEntries([entry({ path: 'a.ts', index: 'modified' })]);
    typeMessage('fix: correct the previous commit');
    fireEvent.click(screen.getByLabelText('Amend the last commit'));

    fireEvent.click(screen.getByRole('button', { name: 'Amend commit' }));

    expect(commitMock).toHaveBeenCalledWith(store, {
      message: 'fix: correct the previous commit',
      amend: true,
    });
  });
});

describe('busy gate', () => {
  it('disables every write action while git is running', () => {
    renderChanges((store) => {
      store.dispatch({
        type: 'status/loaded',
        status: statusOf([
          entry({ path: 'a.ts', index: 'modified' }),
          entry({ path: 'b.ts', worktree: 'modified' }),
        ]),
      });
      store.dispatch({ type: 'busy', busy: true });
    });
    fireEvent.change(screen.getByLabelText('Commit message'), {
      target: { value: 'chore: try' },
    });

    for (const name of [
      'Stage all',
      'Unstage all',
      'Discard all',
      'Stage b.ts',
      'Unstage a.ts',
      'Discard b.ts',
    ]) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    expect(screen.getByLabelText('Commit message')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();
  });

  it('disables the confirmation button while git is running', () => {
    const store = renderWithEntries([entry({ path: 'a.ts', worktree: 'modified' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Discard a.ts' }));

    act(() => store.dispatch({ type: 'busy', busy: true }));

    expect(screen.getByRole('button', { name: 'Discard 1 file' })).toBeDisabled();
  });
});
