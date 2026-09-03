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
import { readHeadMessage } from '../../git/log';
import { revealPath } from '../../config/launch';
import { deleteWorktreeFile } from '../../fs/file';
import { copyText } from '../shell/clipboard';
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
vi.mock('../../git/log', () => ({ readHeadMessage: vi.fn() }));
vi.mock('../../fs/file', () => ({ deleteWorktreeFile: vi.fn() }));
vi.mock('../../config/launch', () => ({ revealPath: vi.fn() }));
vi.mock('../shell/clipboard', () => ({ copyText: vi.fn() }));

const stageMock = vi.mocked(stage);
const unstageMock = vi.mocked(unstage);
const discardMock = vi.mocked(discard);
const commitMock = vi.mocked(commitStaged);
const refreshMock = vi.mocked(refreshStatus);
const suggestMock = vi.mocked(suggestCommitMessage);
const headMessageMock = vi.mocked(readHeadMessage);
const deleteFileMock = vi.mocked(deleteWorktreeFile);
const revealMock = vi.mocked(revealPath);
const copyMock = vi.mocked(copyText);

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

/** Four unstaged files, so a range has an inside and two outsides. */
function fourUnstaged(): Store {
  return renderWithEntries([
    entry({ path: 'a.ts', worktree: 'modified' }),
    entry({ path: 'b.ts', worktree: 'modified' }),
    entry({ path: 'c.ts', worktree: 'modified' }),
    entry({ path: 'd.ts', worktree: 'modified' }),
  ]);
}

/** Clicks a file name in a section, with optional modifier keys. */
function clickPath(
  sectionName: string,
  path: string,
  modifiers: { shiftKey?: boolean; ctrlKey?: boolean } = {},
): void {
  const button = within(section(sectionName)).getByRole('button', {
    name: new RegExp(`^${path}$`),
  });
  act(() => {
    fireEvent.click(button, modifiers);
  });
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
  headMessageMock.mockReset().mockResolvedValue(null);
  deleteFileMock.mockReset().mockResolvedValue(undefined);
  revealMock.mockReset().mockResolvedValue(undefined);
  copyMock.mockReset().mockResolvedValue(true);
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
  it('loads the last commit message when amending, so it can be committed', async () => {
    // Amending replaces the message wholesale. An empty box meant retyping a
    // message git already has — and until it was retyped, the button refused.
    headMessageMock.mockResolvedValue('feat: the thing\n\nWith a body.');
    renderWithEntries([entry({ path: 'a.ts', index: 'modified' })]);

    fireEvent.click(screen.getByLabelText('Amend the last commit'));

    await waitFor(() =>
      expect(screen.getByLabelText('Commit message')).toHaveValue(
        'feat: the thing\n\nWith a body.',
      ),
    );
    expect(screen.getByRole('button', { name: 'Amend commit' })).toBeEnabled();
  });

  it('commits the loaded message unchanged when it is not edited', async () => {
    headMessageMock.mockResolvedValue('feat: the thing');
    const store = renderWithEntries([entry({ path: 'a.ts', index: 'modified' })]);
    fireEvent.click(screen.getByLabelText('Amend the last commit'));
    await waitFor(() =>
      expect(screen.getByLabelText('Commit message')).toHaveValue('feat: the thing'),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Amend commit' }));

    expect(commitMock).toHaveBeenCalledWith(store, {
      message: 'feat: the thing',
      amend: true,
    });
  });

  it('never overwrites a message the user has already written', async () => {
    headMessageMock.mockResolvedValue('feat: the old one');
    renderWithEntries([entry({ path: 'a.ts', index: 'modified' })]);
    typeMessage('fix: what I actually want to say');

    fireEvent.click(screen.getByLabelText('Amend the last commit'));

    await waitFor(() => expect(headMessageMock).not.toHaveBeenCalled());
    expect(screen.getByLabelText('Commit message')).toHaveValue(
      'fix: what I actually want to say',
    );
  });

  it('takes the loaded message away again when amending is unticked', async () => {
    headMessageMock.mockResolvedValue('feat: the old one');
    renderWithEntries([entry({ path: 'a.ts', index: 'modified' })]);
    const box = screen.getByLabelText('Amend the last commit');

    fireEvent.click(box);
    await waitFor(() =>
      expect(screen.getByLabelText('Commit message')).toHaveValue('feat: the old one'),
    );
    fireEvent.click(box);

    // It was never a draft for a new commit; leaving it there would look like
    // one, and commit the old subject again.
    expect(screen.getByLabelText('Commit message')).toHaveValue('');
  });

  it('keeps an edited message when amending is unticked', async () => {
    headMessageMock.mockResolvedValue('feat: the old one');
    renderWithEntries([entry({ path: 'a.ts', index: 'modified' })]);
    const box = screen.getByLabelText('Amend the last commit');

    fireEvent.click(box);
    await waitFor(() =>
      expect(screen.getByLabelText('Commit message')).toHaveValue('feat: the old one'),
    );
    typeMessage('feat: the old one, improved');
    fireEvent.click(box);

    expect(screen.getByLabelText('Commit message')).toHaveValue(
      'feat: the old one, improved',
    );
  });

  it('amends with nothing staged, which is how a message is fixed', async () => {
    headMessageMock.mockResolvedValue('feat: typo in the subejct');
    const store = renderWithEntries([]);

    fireEvent.click(screen.getByLabelText('Amend the last commit'));
    await waitFor(() =>
      expect(screen.getByLabelText('Commit message')).toHaveValue(
        'feat: typo in the subejct',
      ),
    );
    typeMessage('feat: typo in the subject');
    fireEvent.click(screen.getByRole('button', { name: 'Amend commit' }));

    // Nothing staged is only a problem for a plain commit; an amend with an
    // empty index rewrites the message, which is most of what amend is for.
    expect(commitMock).toHaveBeenCalledWith(store, {
      message: 'feat: typo in the subject',
      amend: true,
    });
  });

  it('says what an amend with nothing staged will do', async () => {
    headMessageMock.mockResolvedValue('feat: a thing');
    renderWithEntries([]);
    expect(screen.getByText('Stage at least one file to commit.')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Amend the last commit'));

    expect(
      await screen.findByText(/rewrites the last commit’s message/),
    ).toBeInTheDocument();
  });

  it('still commits when the last message cannot be read', async () => {
    // The box is left typeable; nothing about the amend depended on the read.
    headMessageMock.mockRejectedValue(new Error('no such ref'));
    const store = renderWithEntries([entry({ path: 'a.ts', index: 'modified' })]);

    fireEvent.click(screen.getByLabelText('Amend the last commit'));
    await waitFor(() => expect(headMessageMock).toHaveBeenCalled());
    typeMessage('fix: typed by hand');
    fireEvent.click(screen.getByRole('button', { name: 'Amend commit' }));

    expect(commitMock).toHaveBeenCalledWith(store, {
      message: 'fix: typed by hand',
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

describe('selecting several files at once', () => {
  it('offers no selection action for a single file — the row already has one', () => {
    fourUnstaged();
    clickPath('Unstaged', 'b.ts');
    expect(
      within(section('Unstaged')).queryByRole('button', { name: /selected$/ }),
    ).not.toBeInTheDocument();
  });

  it('shift-click selects the range and stages exactly it', async () => {
    const store = fourUnstaged();

    clickPath('Unstaged', 'b.ts');
    clickPath('Unstaged', 'd.ts', { shiftKey: true });

    const action = within(section('Unstaged')).getByRole('button', {
      name: 'Stage 3 selected',
    });
    await act(async () => {
      fireEvent.click(action);
    });

    expect(stageMock).toHaveBeenCalledWith(store, ['b.ts', 'c.ts', 'd.ts']);
  });

  it('stages in list order, whatever order the files were clicked in', async () => {
    const store = fourUnstaged();

    clickPath('Unstaged', 'd.ts');
    clickPath('Unstaged', 'a.ts', { ctrlKey: true });
    clickPath('Unstaged', 'c.ts', { ctrlKey: true });

    await act(async () => {
      fireEvent.click(
        within(section('Unstaged')).getByRole('button', { name: 'Stage 3 selected' }),
      );
    });

    expect(stageMock).toHaveBeenCalledWith(store, ['a.ts', 'c.ts', 'd.ts']);
  });

  it('extends the same range on a second shift-click rather than starting a new one', () => {
    fourUnstaged();

    clickPath('Unstaged', 'a.ts');
    clickPath('Unstaged', 'd.ts', { shiftKey: true });
    clickPath('Unstaged', 'b.ts', { shiftKey: true });

    expect(
      within(section('Unstaged')).getByRole('button', { name: 'Stage 2 selected' }),
    ).toBeInTheDocument();
  });

  it('ctrl-click removes a file from the selection', () => {
    fourUnstaged();

    clickPath('Unstaged', 'a.ts');
    clickPath('Unstaged', 'c.ts', { shiftKey: true });
    clickPath('Unstaged', 'b.ts', { ctrlKey: true });

    expect(
      within(section('Unstaged')).getByRole('button', { name: 'Stage 2 selected' }),
    ).toBeInTheDocument();
  });

  it('unstages a selection from the staged list, with its own verb', async () => {
    const store = renderWithEntries([
      entry({ path: 'a.ts', index: 'added' }),
      entry({ path: 'b.ts', index: 'added' }),
      entry({ path: 'c.ts', index: 'added' }),
    ]);

    clickPath('Staged', 'a.ts');
    clickPath('Staged', 'c.ts', { shiftKey: true });

    await act(async () => {
      fireEvent.click(
        within(section('Staged')).getByRole('button', { name: 'Unstage 3 selected' }),
      );
    });

    expect(unstageMock).toHaveBeenCalledWith(store, ['a.ts', 'b.ts', 'c.ts']);
  });

  it('drops a selection whose files have left the list', () => {
    const store = fourUnstaged();
    clickPath('Unstaged', 'a.ts');
    clickPath('Unstaged', 'c.ts', { shiftKey: true });

    // b.ts and c.ts get staged from somewhere else; the selection must not
    // keep holding rows nobody can see.
    setEntries(store, [
      entry({ path: 'a.ts', worktree: 'modified' }),
      entry({ path: 'd.ts', worktree: 'modified' }),
    ]);

    expect(
      within(section('Unstaged')).queryByRole('button', { name: /selected$/ }),
    ).not.toBeInTheDocument();
  });

  it('still narrows the diff to the row that was clicked', () => {
    const store = fourUnstaged();

    clickPath('Unstaged', 'b.ts');
    clickPath('Unstaged', 'd.ts', { shiftKey: true });

    expect(store.getState().selection.path).toBe('d.ts');
  });
});

describe('the file context menu', () => {
  /** Right-clicks a row and returns the menu it opened. */
  function openMenu(sectionName: string, path: string): HTMLElement {
    const row = within(section(sectionName))
      .getByRole('button', { name: new RegExp(`^${path}$`) })
      .closest('li');
    if (row === null) throw new Error(`no row for ${path}`);
    act(() => {
      fireEvent.contextMenu(row, { clientX: 20, clientY: 30 });
    });
    return screen.getByRole('menu');
  }

  function choose(menu: HTMLElement, name: RegExp): void {
    act(() => {
      fireEvent.click(within(menu).getByRole('menuitem', { name }));
    });
  }

  it('opens on a right-click and names the file it is about', () => {
    renderWithEntries([entry({ path: 'a.ts', worktree: 'modified' })]);

    const menu = openMenu('Unstaged', 'a.ts');

    expect(menu).toHaveAccessibleName('Actions for a.ts');
    for (const name of [/^Discard changes$/, /^Delete from disk$/, /^Copy path$/]) {
      expect(within(menu).getByRole('menuitem', { name })).toBeInTheDocument();
    }
  });

  it('asks before discarding, exactly as the row button does', async () => {
    renderWithEntries([entry({ path: 'a.ts', worktree: 'modified' })]);

    choose(openMenu('Unstaged', 'a.ts'), /^Discard changes$/);

    // The menu is not a shortcut past the confirmation.
    expect(discardMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm discard' });
    act(() => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Discard 1 file' }));
    });
    await waitFor(() => expect(discardMock).toHaveBeenCalled());
  });

  it('asks before deleting, and only deletes once confirmed', async () => {
    renderWithEntries([entry({ path: 'a.ts', worktree: 'modified' })]);

    choose(openMenu('Unstaged', 'a.ts'), /^Delete from disk$/);

    expect(deleteFileMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm delete' });
    expect(dialog).toHaveTextContent('Delete a.ts from disk?');
    act(() => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete 1 file' }));
    });

    await waitFor(() => expect(deleteFileMock).toHaveBeenCalledWith('/repo', 'a.ts'));
    // The lists are the only place the user can check what is left.
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
  });

  it('cancels a delete without touching the disk', () => {
    renderWithEntries([entry({ path: 'a.ts', worktree: 'modified' })]);

    choose(openMenu('Unstaged', 'a.ts'), /^Delete from disk$/);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });

    expect(deleteFileMock).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('alertdialog', { name: 'Confirm delete' }),
    ).not.toBeInTheDocument();
  });

  it('warns that an untracked file exists nowhere else', () => {
    renderWithEntries([entry({ path: 'new.ts', worktree: 'untracked' })]);

    choose(openMenu('Unstaged', 'new.ts'), /^Delete from disk$/);

    expect(screen.getByRole('alertdialog', { name: 'Confirm delete' })).toHaveTextContent(
      /never seen its contents/i,
    );
  });

  it('says which files survived a delete that failed partway', async () => {
    renderWithEntries([
      entry({ path: 'a.ts', worktree: 'modified' }),
      entry({ path: 'b.ts', worktree: 'modified' }),
    ]);
    deleteFileMock.mockImplementation(async (_repo, path) => {
      if (path === 'b.ts') throw new Error('permission denied');
    });

    clickPath('Unstaged', 'a.ts');
    clickPath('Unstaged', 'b.ts', { shiftKey: true });
    choose(openMenu('Unstaged', 'a.ts'), /^Delete 2 files from disk$/);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete 2 files' }));
    });

    // Every path is attempted even after one fails, and the failure is named.
    await waitFor(() => expect(deleteFileMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /1 of 2 files were not deleted: b\.ts/,
      ),
    );
  });

  it('acts on the whole selection when the clicked row is part of it', () => {
    renderWithEntries([
      entry({ path: 'a.ts', worktree: 'modified' }),
      entry({ path: 'b.ts', worktree: 'modified' }),
      entry({ path: 'c.ts', worktree: 'modified' }),
    ]);

    clickPath('Unstaged', 'a.ts');
    clickPath('Unstaged', 'b.ts', { shiftKey: true });

    expect(openMenu('Unstaged', 'b.ts')).toHaveAccessibleName('Actions for 2 files');
  });

  it('acts on one row alone when it is outside the selection', () => {
    // Otherwise a right-click on an unselected file offers to delete files
    // somewhere else in the list.
    renderWithEntries([
      entry({ path: 'a.ts', worktree: 'modified' }),
      entry({ path: 'b.ts', worktree: 'modified' }),
      entry({ path: 'c.ts', worktree: 'modified' }),
    ]);

    clickPath('Unstaged', 'a.ts');
    clickPath('Unstaged', 'b.ts', { shiftKey: true });

    expect(openMenu('Unstaged', 'c.ts')).toHaveAccessibleName('Actions for c.ts');
  });

  it('copies the path git speaks and the one the rest of the machine speaks', async () => {
    renderWithEntries([entry({ path: 'src/a.ts', worktree: 'modified' })]);

    choose(openMenu('Unstaged', 'src/a.ts'), /^Copy path$/);
    await waitFor(() => expect(copyMock).toHaveBeenCalledWith('src/a.ts'));

    choose(openMenu('Unstaged', 'src/a.ts'), /^Copy full path$/);
    await waitFor(() => expect(copyMock).toHaveBeenCalledWith('/repo/src/a.ts'));
  });

  it('says so when the clipboard refused the copy', async () => {
    // A copy that did not happen is otherwise only discovered at the paste.
    copyMock.mockResolvedValue(false);
    renderWithEntries([entry({ path: 'a.ts', worktree: 'modified' })]);

    choose(openMenu('Unstaged', 'a.ts'), /^Copy path$/);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'The path could not be copied.',
      ),
    );
  });

  it('reveals the absolute path, not the one git prints', async () => {
    renderWithEntries([entry({ path: 'src/a.ts', worktree: 'modified' })]);

    choose(openMenu('Unstaged', 'src/a.ts'), /^Reveal in file manager$/);

    await waitFor(() => expect(revealMock).toHaveBeenCalledWith('/repo/src/a.ts'));
  });

  it('reports a file manager that would not start', async () => {
    revealMock.mockRejectedValue(new Error('Could not start explorer'));
    renderWithEntries([entry({ path: 'a.ts', worktree: 'modified' })]);

    choose(openMenu('Unstaged', 'a.ts'), /^Reveal in file manager$/);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /Could not open the file manager/,
      ),
    );
  });

  it('refuses to discard from the staged list, with the reason on the item', () => {
    // The staged row has no unstaged edit to drop, and discarding there would
    // have to take the staged snapshot instead.
    renderWithEntries([entry({ path: 'a.ts', index: 'modified' })]);

    const menu = openMenu('Staged', 'a.ts');
    const item = within(menu).getByRole('menuitem', { name: /^Discard changes$/ });

    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(menu).toHaveTextContent(/no unstaged changes/i);
    choose(menu, /^Discard changes$/);
    expect(screen.queryByRole('alertdialog', { name: 'Confirm discard' })).toBeNull();
  });
});
