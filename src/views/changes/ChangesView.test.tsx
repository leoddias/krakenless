import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoStatus, StatusEntry } from '../../git/types';
import {
  commitStaged,
  discard,
  refreshStatus,
  stage,
  suggestCommitMessage,
  unstage,
} from '../../state/actions';
import { StoreProvider } from '../../state/hooks';
import { createStore, type Store } from '../../state/store';
import { ChangesView } from './ChangesView';

vi.mock('../../state/actions', () => ({
  stage: vi.fn(),
  unstage: vi.fn(),
  discard: vi.fn(),
  commitStaged: vi.fn(),
  refreshStatus: vi.fn(),
  suggestCommitMessage: vi.fn(),
}));

const stageMock = vi.mocked(stage);
const unstageMock = vi.mocked(unstage);
const discardMock = vi.mocked(discard);
const commitMock = vi.mocked(commitStaged);
const refreshMock = vi.mocked(refreshStatus);
const suggestMock = vi.mocked(suggestCommitMessage);

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

function openRepo(store: Store): void {
  store.dispatch({
    type: 'repo/opened',
    repo: { root: '/repo', gitDir: '/repo/.git', bare: false, empty: false },
  });
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
  return renderChanges((store) => {
    // `repo/opened` resets derived state, so it has to come first.
    openRepo(store);
    store.dispatch({ type: 'status/loaded', status: statusOf(entries) });
  });
}

function setEntries(store: Store, entries: StatusEntry[]): void {
  act(() => store.dispatch({ type: 'status/loaded', status: statusOf(entries) }));
}

function section(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

beforeEach(() => {
  stageMock.mockReset().mockResolvedValue(undefined);
  unstageMock.mockReset().mockResolvedValue(undefined);
  discardMock.mockReset().mockResolvedValue({
    discarded: true,
    stashLabel: 'krakenless: discarded now',
    undoCommands: ['git restore --source=abc123 --worktree -- "a.ts"'],
    notes: [],
  });
  commitMock.mockReset().mockResolvedValue(undefined);
  refreshMock.mockReset().mockResolvedValue(undefined);
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
  it('puts unstaged above staged, with the commit box under the list it commits', () => {
    renderWithEntries([
      entry({ path: 'staged.ts', index: 'modified' }),
      entry({ path: 'edited.ts', worktree: 'modified' }),
    ]);

    const headings = screen.getAllByRole('heading').map((node) => node.textContent ?? '');
    const unstaged = headings.findIndex((text) => text.startsWith('Unstaged'));
    const staged = headings.findIndex((text) => text.startsWith('Staged'));

    expect(unstaged).toBeGreaterThan(-1);
    expect(unstaged).toBeLessThan(staged);
  });

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

  it('shows the state letter next to its spelled-out label', () => {
    renderWithEntries([entry({ path: 'edited.ts', worktree: 'modified' })]);

    const row = within(section('Unstaged')).getByRole('listitem');
    expect(within(row).getByText('M')).toBeInTheDocument();
    expect(within(row).getByText('Modified')).toBeInTheDocument();
  });

  it('shows each side of a path that is staged and edited again', () => {
    renderWithEntries([entry({ path: 'both.ts', index: 'added', worktree: 'modified' })]);

    expect(within(section('Staged')).getByText('Added')).toBeInTheDocument();
    expect(within(section('Unstaged')).getByText('Modified')).toBeInTheDocument();
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

  it('stages a rename by both of its paths, not by its display text', () => {
    const store = renderWithEntries([
      entry({ path: 'new.ts', origPath: 'old.ts', worktree: 'renamed' }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Stage old.ts → new.ts' }));

    expect(stageMock).toHaveBeenCalledWith(store, ['old.ts', 'new.ts']);
  });

  it('unstages a rename by both of its paths', () => {
    // Unstaging only `new.ts` would leave `old.ts` staged as a deletion — half
    // a rename, and not what the row promised.
    const store = renderWithEntries([
      entry({ path: 'new.ts', origPath: 'old.ts', index: 'renamed' }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Unstage old.ts → new.ts' }));

    expect(unstageMock).toHaveBeenCalledWith(store, ['old.ts', 'new.ts']);
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

  it('unstages all staged paths at once, renames included whole', () => {
    const store = renderWithEntries([
      entry({ path: 'a.ts', index: 'added' }),
      entry({ path: 'new.ts', origPath: 'old.ts', index: 'renamed' }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Unstage all' }));

    expect(unstageMock).toHaveBeenCalledWith(store, ['a.ts', 'old.ts', 'new.ts']);
  });

  it('reports a failed staging and re-reads the status', async () => {
    stageMock.mockRejectedValue(new Error('fatal: Unable to create index.lock'));
    const store = renderWithEntries([entry({ path: 'a.ts', worktree: 'modified' })]);

    fireEvent.click(screen.getByRole('button', { name: 'Stage a.ts' }));

    const alert = await screen.findByRole('alert');
    // `git add` can stage part of its pathspec and still fail, so the lists on
    // screen cannot be trusted until they are read again.
    expect(alert).toHaveTextContent('may already have been applied');
    expect(alert).toHaveTextContent('fatal: Unable to create index.lock');
    expect(refreshMock).toHaveBeenCalledWith(store);
  });

  it('reports a failed unstaging the same way', async () => {
    unstageMock.mockRejectedValue(new Error('fatal: pathspec did not match'));
    renderWithEntries([entry({ path: 'a.ts', index: 'modified' })]);

    fireEvent.click(screen.getByRole('button', { name: 'Unstage a.ts' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Unstaging failed');
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

  function confirm(): void {
    fireEvent.click(screen.getByRole('button', { name: /^Discard \d+ files?$/ }));
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

  it('names both halves of a rename it is about to discard', () => {
    const store = renderWithEntries([
      entry({ path: 'new.ts', origPath: 'old.ts', worktree: 'renamed' }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Discard old.ts → new.ts' }));

    const dialog = screen.getByRole('alertdialog', { name: 'Confirm discard' });
    expect(dialog).toHaveTextContent('Discard changes to 2 files?');
    expect(within(dialog).getByText('old.ts')).toBeInTheDocument();
    expect(within(dialog).getByText('new.ts')).toBeInTheDocument();

    confirm();
    // The third argument is the exact question the user answered; the git
    // layer mints its confirmation token from it.
    expect(discardMock).toHaveBeenCalledWith(
      store,
      ['old.ts', 'new.ts'],
      expect.stringContaining('Discard changes to'),
    );
  });

  it('says the staged side is kept when a path has both', () => {
    renderWithEntries([
      entry({ path: 'both.ts', index: 'modified', worktree: 'modified' }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Discard both.ts' }));

    const dialog = screen.getByRole('alertdialog', { name: 'Confirm discard' });
    expect(dialog).toHaveTextContent('also has staged changes');
    // The staged snapshot survives the discard (`--keep-index`), so the dialog
    // must say so rather than warning that it is swept away.
    expect(dialog).toHaveTextContent('staged version is kept');
  });

  it('cancels without discarding anything', () => {
    renderOneUnstaged();
    fireEvent.click(screen.getByRole('button', { name: 'Discard a.ts' }));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(discardMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('cancels on Escape', () => {
    renderOneUnstaged();
    fireEvent.click(screen.getByRole('button', { name: 'Discard a.ts' }));

    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(discardMock).not.toHaveBeenCalled();
  });

  it('focuses the safe choice so a stray Enter cannot discard', () => {
    renderOneUnstaged();
    fireEvent.click(screen.getByRole('button', { name: 'Discard a.ts' }));

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('discards only after the confirmation button', async () => {
    const store = renderOneUnstaged();
    fireEvent.click(screen.getByRole('button', { name: 'Discard a.ts' }));

    confirm();

    expect(discardMock).toHaveBeenCalledWith(
      store,
      ['a.ts'],
      expect.stringContaining('Discard changes to'),
    );
    await screen.findByText(/git restore --source=/);
  });

  it('re-asks instead of discarding when the working tree moved underneath', () => {
    const store = renderWithEntries([
      entry({ path: 'a.ts', worktree: 'modified' }),
      entry({ path: 'b.ts', worktree: 'modified' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Discard all' }));

    // Someone reverts b.ts while the dialog is open.
    setEntries(store, [entry({ path: 'a.ts', worktree: 'modified' })]);
    confirm();

    expect(discardMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm discard' });
    expect(dialog).toHaveTextContent('The working tree changed while this was open');
    expect(dialog).toHaveTextContent('Discard changes to 1 file?');
    expect(within(dialog).queryByText('b.ts')).not.toBeInTheDocument();

    // The re-confirmed, smaller set is what actually runs.
    confirm();
    expect(discardMock).toHaveBeenCalledWith(
      store,
      ['a.ts'],
      expect.stringContaining('Discard changes to'),
    );
  });

  it('discards nothing when every pending path has gone clean', () => {
    const store = renderOneUnstaged();
    fireEvent.click(screen.getByRole('button', { name: 'Discard a.ts' }));

    setEntries(store, []);
    confirm();

    expect(discardMock).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Those paths no longer have unstaged changes',
    );
  });

  it('keeps the recovery command on screen after the discard', async () => {
    discardMock.mockResolvedValue({
      discarded: true,
      stashLabel: 'krakenless: discarded 2026-08-20',
      undoCommands: ['git restore --source=abc123 --worktree -- "a.ts"'],
      notes: [],
    });
    const store = renderOneUnstaged();
    fireEvent.click(screen.getByRole('button', { name: 'Discard a.ts' }));
    confirm();

    const notice = await screen.findByRole('status');
    // The command must be shown verbatim: it is the only route back, and it
    // carries the stash oid the user cannot reconstruct.
    expect(notice).toHaveTextContent('git restore --source=abc123 --worktree');
    expect(notice).toHaveTextContent('staged version');
    expect(within(notice).getByText('a.ts')).toBeInTheDocument();

    // It survives whatever the status panel does next — including failing —
    // because it carries the only instructions for getting the work back.
    act(() =>
      store.dispatch({ type: 'status/failed', message: 'fatal: index.lock exists' }),
    );
    expect(screen.getByRole('status')).toHaveTextContent('git restore --source=');

    fireEvent.click(
      within(screen.getByRole('status')).getByRole('button', { name: 'Dismiss' }),
    );
    expect(screen.queryByText(/git stash pop/)).not.toBeInTheDocument();
  });

  it('never claims a recovery that did not happen', async () => {
    discardMock.mockResolvedValue(null);
    renderOneUnstaged();
    fireEvent.click(screen.getByRole('button', { name: 'Discard a.ts' }));
    confirm();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Nothing was discarded');
    expect(screen.queryByText(/git stash pop/)).not.toBeInTheDocument();
  });

  it('reports a failed discard as changes still present', async () => {
    discardMock.mockRejectedValue(new Error('fatal: cannot save the current worktree'));
    renderOneUnstaged();
    fireEvent.click(screen.getByRole('button', { name: 'Discard a.ts' }));
    confirm();

    const alert = await screen.findByRole('alert');
    // An interrupted `git stash push` can have written the entry anyway, so the
    // message must not promise the working tree is untouched.
    expect(alert).toHaveTextContent('Check `git stash list` before retrying');
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

    // Staging an unmerged path as it stands records the conflict markers as
    // the resolution, so neither action is offered at all.
    expect(
      screen.queryByRole('button', { name: 'Stage merge.ts' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Discard merge.ts' }),
    ).not.toBeInTheDocument();
  });

  it('opens the resolver when the file is clicked', () => {
    const store = renderWithEntries([conflicted]);

    fireEvent.click(
      within(section('Conflicted')).getByRole('button', { name: /merge\.ts/ }),
    );

    // Clicking a conflicted file is the first thing anybody tries, and it used
    // to do nothing at all.
    expect(store.getState().resolving).toBe('merge.ts');
  });

  it('keeps them out of the bulk actions', () => {
    const store = renderWithEntries([
      conflicted,
      entry({ path: 'a.ts', worktree: 'modified' }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Stage all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard all' }));

    expect(stageMock).toHaveBeenCalledWith(store, ['a.ts']);
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm discard' });
    expect(within(dialog).queryByText('merge.ts')).not.toBeInTheDocument();
  });

  it('explains the conflict and why staging is withheld', () => {
    renderWithEntries([conflicted]);

    const region = section('Conflicted');
    expect(region).toHaveTextContent('Both sides changed this file.');
    expect(region).toHaveTextContent('Click a file to resolve it side by side.');
    expect(region).toHaveTextContent('never staged or discarded as it stands');
  });

  it('does not let a conflicted path alone enable committing', () => {
    renderWithEntries([conflicted]);

    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();
  });

  it('withholds amend while the repository has conflicts', () => {
    renderWithEntries([conflicted, entry({ path: 'a.ts', index: 'modified' })]);

    expect(screen.getByLabelText('Amend the last commit')).toBeDisabled();
    expect(
      screen.getByText('Amending is unavailable while the repository has conflicts.'),
    ).toBeInTheDocument();
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

  it('keeps the message when there is no repository to commit to', () => {
    // The action layer returns silently in that case, so clearing the box
    // would look like a commit that never happened.
    renderChanges((store) =>
      store.dispatch({
        type: 'status/loaded',
        status: statusOf([entry({ path: 'a.ts', index: 'modified' })]),
      }),
    );
    typeMessage('feat: add a thing');

    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));

    expect(commitMock).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('No repository is open.');
    expect(screen.getByLabelText('Commit message')).toHaveValue('feat: add a thing');
  });

  it('warns that amending rewrites the last commit and names it', () => {
    renderWithEntries([entry({ path: 'a.ts', index: 'modified' })]);

    fireEvent.click(screen.getByLabelText('Amend the last commit'));

    const warning = screen.getByText(/Amending rewrites the last commit/);
    expect(warning).toHaveTextContent('aaaaaaa');
    expect(warning).toHaveTextContent('reflog');
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
  it('keeps the draft when a refresh unmounts the lists', () => {
    const store = renderWithEntries([entry({ path: 'a.ts', index: 'modified' })]);
    typeMessage('feat: a long message the user is still writing');

    act(() => store.dispatch({ type: 'status/loading' }));
    setEntries(store, [entry({ path: 'a.ts', index: 'modified' })]);

    expect(screen.getByLabelText('Commit message')).toHaveValue(
      'feat: a long message the user is still writing',
    );
  });

  it('never sends amend once amending has been withheld', () => {
    const store = renderWithEntries([entry({ path: 'a.ts', index: 'modified' })]);
    typeMessage('feat: add a thing');
    fireEvent.click(screen.getByLabelText('Amend the last commit'));

    // A merge starts underneath: amending would rewrite a commit mid-operation.
    setEntries(store, [
      entry({ path: 'a.ts', index: 'modified' }),
      entry({
        path: 'merge.ts',
        index: 'unmerged',
        worktree: 'unmerged',
        conflicted: true,
        conflictKind: 'UU',
      }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));

    expect(commitMock).toHaveBeenCalledWith(store, {
      message: 'feat: add a thing',
      amend: false,
    });
  });
});

describe('discard notices over time', () => {
  it('does not check, and does not claim, while the status is reloading', () => {
    const store = renderWithEntries([entry({ path: 'a.ts', worktree: 'modified' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Discard a.ts' }));

    act(() => store.dispatch({ type: 'status/loading' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard 1 file' }));

    expect(discardMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm discard' });
    expect(dialog).toHaveTextContent('The working tree is being re-read');
    expect(screen.queryByText(/no longer have unstaged changes/)).not.toBeInTheDocument();
  });

  it('shows what the recovery command cannot bring back', async () => {
    // The model layer computes this sentence; a view that drops it shows one
    // command above a path list it does not cover, which reads as "this
    // restores all of them". That is exactly what went wrong once already.
    discardMock.mockResolvedValue({
      discarded: true,
      stashLabel: 'krakenless: mixed',
      undoCommands: ['git restore --source=abc123 --worktree -- "a.ts"'],
      notes: [
        'The stash abc123 also holds "gone.ts", which this command cannot restore.',
      ],
    });
    renderWithEntries([entry({ path: 'a.ts', worktree: 'modified' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Discard a.ts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard 1 file' }));

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('also holds "gone.ts"');
    expect(notice).toHaveTextContent('git restore --source=abc123');
  });

  it('does not promise a command when there is none to run', async () => {
    // Discarding a deletion creates a stash but yields no runnable restore.
    // A heading over an empty block claims a route the code declined to offer.
    discardMock.mockResolvedValue({
      discarded: true,
      stashLabel: 'krakenless: deletion',
      undoCommands: [],
      notes: ['The stash abc123 also holds "a.ts", which this command cannot restore.'],
    });
    renderWithEntries([entry({ path: 'a.ts', worktree: 'modified' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Discard a.ts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard 1 file' }));

    const notice = await screen.findByRole('status');
    expect(notice).not.toHaveTextContent('Run this to bring them back');
    expect(notice).toHaveTextContent('no single command that restores this one');
  });

  it('keeps the earlier recovery notice when a second discard is confirmed', async () => {
    discardMock.mockResolvedValueOnce({
      discarded: true,
      stashLabel: 'krakenless: first',
      undoCommands: ['git restore --source=aaa111 --worktree -- "a.ts"'],
      notes: [],
    });
    const store = renderWithEntries([
      entry({ path: 'a.ts', worktree: 'modified' }),
      entry({ path: 'b.ts', worktree: 'modified' }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Discard a.ts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard 1 file' }));
    await screen.findByText(/aaa111/);

    discardMock.mockResolvedValueOnce({
      discarded: true,
      stashLabel: 'krakenless: second',
      undoCommands: ['git restore --source=bbb222 --worktree -- "b.ts"'],
      notes: [],
    });
    setEntries(store, [entry({ path: 'b.ts', worktree: 'modified' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Discard b.ts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard 1 file' }));

    await screen.findByText(/bbb222/);
    // The first stash still exists; dropping its instructions would strand it.
    expect(screen.getByText(/aaa111/)).toBeInTheDocument();
  });

  it('keeps the staged-side warning when the status stops being readable', () => {
    const store = renderWithEntries([
      entry({ path: 'both.ts', index: 'modified', worktree: 'modified' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Discard both.ts' }));

    act(() => store.dispatch({ type: 'status/loading' }));

    expect(screen.getByRole('alertdialog')).toHaveTextContent('also has staged changes');
  });
});

describe('busy gate', () => {
  it('disables every write action while git is running', () => {
    renderChanges((store) => {
      openRepo(store);
      store.dispatch({
        type: 'status/loaded',
        status: statusOf([
          entry({ path: 'a.ts', index: 'modified' }),
          entry({ path: 'b.ts', worktree: 'modified' }),
        ]),
      });
      store.dispatch({ type: 'busy', busy: true });
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
    expect(screen.getByLabelText('Amend the last commit')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();
  });

  it('disables the confirmation button while git is running', () => {
    const store = renderWithEntries([entry({ path: 'a.ts', worktree: 'modified' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Discard a.ts' }));

    act(() => store.dispatch({ type: 'busy', busy: true }));

    expect(screen.getByRole('button', { name: 'Discard 1 file' })).toBeDisabled();
  });
});

describe('the AI Commit button', () => {
  /** A repository with one staged file, which is what the button needs. */
  function withStaged(): Store {
    return renderWithEntries([entry({ path: 'a.ts', index: 'modified' })]);
  }

  beforeEach(() => {
    suggestMock
      .mockReset()
      .mockResolvedValue({ message: 'feat: add a thing', kind: 'patch' });
  });

  function aiButton(): HTMLElement {
    return screen.getByRole('button', { name: 'AI Commit' });
  }

  it('sits next to Commit', () => {
    withStaged();
    expect(aiButton()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Commit' })).toBeInTheDocument();
  });

  it('fills the message box and never commits', async () => {
    // The whole safety property of this feature: a model's sentence about
    // somebody's code is a draft, and a person presses Commit.
    withStaged();

    fireEvent.click(aiButton());

    await waitFor(() =>
      expect(screen.getByLabelText('Commit message')).toHaveValue('feat: add a thing'),
    );
    expect(commitMock).not.toHaveBeenCalled();
  });

  it('is off until something is staged', () => {
    renderWithEntries([entry({ path: 'a.ts', worktree: 'modified' })]);
    expect(aiButton()).toBeDisabled();
  });

  it('is off when no AI command is configured', () => {
    renderChanges((store) => {
      openRepo(store);
      store.dispatch({
        type: 'config/loaded',
        config: { ...store.getState().config, aiCommand: '   ' },
      });
      store.dispatch({
        type: 'status/loaded',
        status: statusOf([entry({ path: 'a.ts', index: 'modified' })]),
      });
    });

    expect(aiButton()).toBeDisabled();
    expect(aiButton()).toHaveAttribute('title', expect.stringContaining('Settings'));
  });

  it('says when the message came from a file summary, not the diff', async () => {
    // Otherwise the user weighs a vaguer message as if it had seen the code.
    suggestMock.mockResolvedValue({ message: 'chore: update files', kind: 'summary' });
    withStaged();

    fireEvent.click(aiButton());

    expect(await screen.findByText(/too large to send whole/)).toBeInTheDocument();
  });

  it('shows a failure without labelling it a commit failure', async () => {
    suggestMock.mockRejectedValue(new Error('Could not start "claude"'));
    withStaged();

    fireEvent.click(aiButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not start "claude"');
    expect(alert).not.toHaveTextContent('Commit failed');
  });

  it('leaves what the user typed alone when it fails', async () => {
    suggestMock.mockRejectedValue(new Error('nope'));
    withStaged();
    const box = screen.getByLabelText('Commit message');
    fireEvent.change(box, { target: { value: 'my own message' } });

    fireEvent.click(aiButton());

    await screen.findByRole('alert');
    expect(box).toHaveValue('my own message');
  });
});
