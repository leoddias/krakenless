import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictBanner } from './ConflictBanner';
import { conflictDescription, offersMergetool } from './conflicts';
import { StoreProvider } from '../../state/hooks';
import { createStore, type Store } from '../../state/store';
import type { RepoStatus, StatusEntry } from '../../git/types';

const openInEditor = vi.hoisted(() => vi.fn());
const openMergetool = vi.hoisted(() => vi.fn());
const refreshStatus = vi.hoisted(() => vi.fn());

vi.mock('../../state/actions', () => ({
  openInEditor,
  openMergetool,
  refreshStatus,
}));

function conflict(path: string, kind: StatusEntry['conflictKind']): StatusEntry {
  return {
    path,
    index: 'unmerged',
    worktree: 'unmerged',
    conflicted: true,
    conflictKind: kind,
  };
}

function status(entries: StatusEntry[]): RepoStatus {
  return {
    branch: 'main',
    head: 'abc1234',
    detached: false,
    entries,
    hasConflicts: entries.some((entry) => entry.conflicted),
  };
}

function renderBanner(entries: StatusEntry[]): Store {
  const store = createStore();
  store.dispatch({ type: 'status/loaded', status: status(entries) });
  render(
    <StoreProvider store={store}>
      <ConflictBanner />
    </StoreProvider>,
  );
  return store;
}

describe('conflictDescription', () => {
  it.each([
    ['UU' as const, 'Both sides changed'],
    ['AA' as const, 'Both sides added'],
    ['DU' as const, 'You deleted it'],
    ['UD' as const, 'They deleted it'],
  ])('describes %s in terms of the decision', (kind, expected) => {
    expect(conflictDescription(kind)).toContain(expected);
  });

  it('says something honest for an unrecorded kind', () => {
    expect(conflictDescription(undefined)).toContain('conflicted');
  });
});

describe('offersMergetool', () => {
  it('offers a merge tool for content conflicts', () => {
    expect(offersMergetool('UU')).toBe(true);
    expect(offersMergetool('AA')).toBe(true);
  });

  it('does not offer one for keep-vs-delete conflicts', () => {
    // There is no text to merge; the decision is keep or remove, and a merge
    // tool would misrepresent the choice.
    expect(offersMergetool('DU')).toBe(false);
    expect(offersMergetool('UD')).toBe(false);
    expect(offersMergetool('DD')).toBe(false);
  });
});

describe('ConflictBanner', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    openInEditor.mockResolvedValue(true);
    openMergetool.mockResolvedValue(true);
    refreshStatus.mockResolvedValue(undefined);
  });

  it('renders nothing when there are no conflicts', () => {
    renderBanner([
      { path: 'a.ts', index: 'modified', worktree: 'unmodified', conflicted: false },
    ]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders nothing before the status has been read', () => {
    render(
      <StoreProvider store={createStore()}>
        <ConflictBanner />
      </StoreProvider>,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('lists every conflicted path with what the conflict is', () => {
    renderBanner([conflict('src/a.ts', 'UU'), conflict('src/b.ts', 'DU')]);

    expect(screen.getByText('2 files are conflicted')).toBeInTheDocument();
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('You deleted it; they changed it.')).toBeInTheDocument();
  });

  it('names the operation that stopped, rather than assuming a merge', () => {
    // The whole bug in one assertion: during a rebase this used to say "merge"
    // and offer `git merge --abort`, which fails and strands the user.
    const store = renderBanner([conflict('a.ts', 'UU')]);
    act(() =>
      store.dispatch({
        type: 'operation/read',
        operation: {
          kind: 'rebase',
          commit: null,
          step: 3,
          steps: 43,
          branch: 'feat/x',
        },
      }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Stopped during a rebase');
  });

  it('sends the user to the controls that can actually end the operation', () => {
    renderBanner([conflict('a.ts', 'UU')]);
    // They live with the commit box, because a rebase can stop with nothing
    // conflicted and this banner would then not be on screen at all.
    expect(screen.getByRole('alert')).toHaveTextContent('under the commit box');
    expect(screen.queryByRole('button', { name: /Abort/ })).toBeNull();
  });

  it('opens a file in the editor', () => {
    const store = renderBanner([conflict('a.ts', 'UU')]);
    fireEvent.click(screen.getByRole('button', { name: 'Open in editor' }));
    expect(openInEditor).toHaveBeenCalledWith(store, 'a.ts');
  });

  it('offers a merge tool only where one makes sense', () => {
    renderBanner([conflict('content.ts', 'UU'), conflict('deleted.ts', 'UD')]);
    expect(screen.getAllByRole('button', { name: 'Merge tool' })).toHaveLength(1);
  });

  it('runs the merge tool for the chosen path', () => {
    const store = renderBanner([conflict('a.ts', 'UU')]);
    fireEvent.click(screen.getByRole('button', { name: 'Merge tool' }));
    expect(openMergetool).toHaveBeenCalledWith(store, 'a.ts');
  });

  it('re-checks the status on demand', () => {
    const store = renderBanner([conflict('a.ts', 'UU')]);
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }));
    expect(refreshStatus).toHaveBeenCalledWith(store);
  });

  it('disables every action while a write is in flight', () => {
    const store = renderBanner([conflict('a.ts', 'UU')]);
    // The dispatch happens outside React's own event handling, so the render it
    // triggers has to be flushed before asserting on the DOM.
    act(() => store.dispatch({ type: 'busy', busy: true }));

    expect(screen.getByRole('button', { name: 'Open in editor' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Re-check' })).toBeDisabled();
  });
});
