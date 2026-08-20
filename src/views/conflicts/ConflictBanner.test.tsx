import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictBanner } from './ConflictBanner';
import { conflictDescription, offersMergetool } from './conflicts';
import { StoreProvider } from '../../state/hooks';
import { createStore, type Store } from '../../state/store';
import type { RepoStatus, StatusEntry } from '../../git/types';

const openInEditor = vi.hoisted(() => vi.fn());
const openMergetool = vi.hoisted(() => vi.fn());
const abortMergeInProgress = vi.hoisted(() => vi.fn());
const refreshStatus = vi.hoisted(() => vi.fn());

vi.mock('../../state/actions', () => ({
  openInEditor,
  openMergetool,
  abortMergeInProgress,
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
    abortMergeInProgress.mockResolvedValue(true);
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

  it('says plainly that it does not resolve conflicts', () => {
    // Offering a "resolve" button it cannot honour is the failure this banner
    // exists to prevent.
    renderBanner([conflict('a.ts', 'UU')]);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'does not resolve conflicts itself',
    );
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

  it('never aborts without a second, explicit confirmation', () => {
    renderBanner([conflict('a.ts', 'UU')]);

    fireEvent.click(screen.getByRole('button', { name: 'Abort merge…' }));
    expect(abortMergeInProgress).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Abort merge' }));
    expect(abortMergeInProgress).toHaveBeenCalledTimes(1);
  });

  it('passes the text the user agreed to as the confirmation', () => {
    const store = renderBanner([conflict('a.ts', 'UU')]);
    fireEvent.click(screen.getByRole('button', { name: 'Abort merge…' }));
    const question = screen.getByText(/Abort the merge and return/).textContent ?? '';
    fireEvent.click(screen.getByRole('button', { name: 'Abort merge' }));

    expect(abortMergeInProgress).toHaveBeenCalledWith(store, question);
    expect(question).toContain('will be lost');
  });

  it('lets the user back out of aborting', () => {
    renderBanner([conflict('a.ts', 'UU')]);
    fireEvent.click(screen.getByRole('button', { name: 'Abort merge…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep merging' }));

    expect(abortMergeInProgress).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Abort merge…' })).toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: 'Abort merge…' })).toBeDisabled();
  });
});
