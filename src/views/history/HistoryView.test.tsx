import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../config/schema';
import type { Commit } from '../../git/types';
import { selectCommit } from '../../state/actions';
import { StoreProvider } from '../../state/hooks';
import { createStore, type Store } from '../../state/store';
import { HistoryView, ROW_HEIGHT } from './HistoryView';

vi.mock('../../state/actions', () => ({
  selectCommit: vi.fn(),
}));

const selectCommitMock = vi.mocked(selectCommit);

const NOW = new Date('2026-08-20T12:00:00Z');

function makeCommit(index: number, overrides: Partial<Commit> = {}): Commit {
  const oid = `${index}`.padStart(40, 'a');
  return {
    oid,
    shortOid: oid.slice(0, 7),
    parents: [],
    authorName: `Author ${index}`,
    authorEmail: `author${index}@example.com`,
    authorDate: '2026-08-17T12:00:00Z',
    committerName: `Author ${index}`,
    committerDate: '2026-08-17T12:00:00Z',
    subject: `Commit ${index}`,
    body: '',
    refs: [],
    ...overrides,
  };
}

function renderHistory(prepare: (store: Store) => void = () => {}): Store {
  const store = createStore();
  prepare(store);
  render(
    <StoreProvider store={store}>
      <HistoryView />
    </StoreProvider>,
  );
  return store;
}

function renderWithCommits(commits: Commit[]): Store {
  return renderHistory((store) => store.dispatch({ type: 'commits/loaded', commits }));
}

function rowButtons(): HTMLElement[] {
  return within(screen.getByRole('group', { name: 'Commits' })).getAllByRole('button');
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  selectCommitMock.mockReset();
  // The real action dispatches the selection; keep that behaviour so the view
  // can be observed reacting to it.
  selectCommitMock.mockImplementation((store, oid) => {
    store.dispatch({ type: 'selection/commit', oid });
    return Promise.resolve();
  });
});

afterEach(() => {
  // Testing Library only auto-cleans with `globals: true`, which this project
  // does not use.
  cleanup();
  vi.useRealTimers();
});

describe('HistoryView panel states', () => {
  it('invites the user to open a repository while idle', () => {
    renderHistory();
    expect(screen.getByText('Open a repository to see its history.')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Commits' })).not.toBeInTheDocument();
  });

  it('announces loading', () => {
    renderHistory((store) => store.dispatch({ type: 'commits/loading' }));
    expect(screen.getByRole('status')).toHaveTextContent('Loading history…');
  });

  it('shows the error message and its kind', () => {
    renderHistory((store) =>
      store.dispatch({
        type: 'commits/failed',
        message: 'fatal: your current branch does not have any commits yet',
        kind: 'command-failed',
      }),
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      'fatal: your current branch does not have any commits yet',
    );
    expect(alert).toHaveTextContent('Reason: command-failed');
  });

  it('omits the reason when the error carries no kind', () => {
    renderHistory((store) =>
      store.dispatch({ type: 'commits/failed', message: 'git exploded' }),
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('Reason:');
  });

  it('says a repository has no commits yet, keeping the working tree row', () => {
    renderWithCommits([]);
    expect(
      screen.getByText('No commits yet — this repository has no history.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Working tree/ })).toBeInTheDocument();
  });
});

describe('HistoryView rows', () => {
  it('renders oid, subject, author and relative date for each commit', () => {
    renderWithCommits([makeCommit(1), makeCommit(2)]);

    const row = screen.getByRole('button', { name: /Commit 1/ });
    expect(within(row).getByText(makeCommit(1).shortOid)).toBeInTheDocument();
    expect(within(row).getByText('Commit 1')).toBeInTheDocument();
    expect(within(row).getByText('Author 1')).toBeInTheDocument();
    // NOW is 2026-08-20T12:00:00Z, the commit is dated three days earlier.
    expect(within(row).getByText('3 days ago')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Commit 2/ })).toBeInTheDocument();
  });

  it('falls back to a placeholder when a commit has an empty subject', () => {
    renderWithCommits([makeCommit(1, { subject: '' })]);
    expect(screen.getByText('(no subject)')).toBeInTheDocument();
  });

  it('renders one chip per ref, tagged with its kind', () => {
    renderWithCommits([
      makeCommit(1, {
        refs: [
          { kind: 'head', name: 'HEAD' },
          { kind: 'branch', name: 'main' },
          { kind: 'remote-branch', name: 'origin/main' },
          { kind: 'tag', name: 'v0.1.0' },
        ],
      }),
    ]);

    const row = screen.getByRole('button', { name: /Commit 1/ });
    const chips = [...row.querySelectorAll('[data-ref-kind]')];
    expect(
      chips.map((chip) => [chip.getAttribute('data-ref-kind'), chip.textContent]),
    ).toEqual([
      ['head', 'HEAD'],
      ['branch', 'main'],
      ['remote-branch', 'origin/main'],
      ['tag', 'v0.1.0'],
    ]);
  });

  it('renders no chip markup at all for a commit without refs', () => {
    renderWithCommits([makeCommit(1)]);
    const row = screen.getByRole('button', { name: /Commit 1/ });
    expect(row.querySelectorAll('[data-ref-kind]')).toHaveLength(0);
  });

  it('marks the selected row with aria-current', () => {
    renderWithCommits([makeCommit(1), makeCommit(2)]);
    expect(screen.getByRole('button', { name: /Working tree/ })).toHaveAttribute(
      'aria-current',
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: /Commit 2/ }));

    expect(screen.getByRole('button', { name: /Commit 2/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('button', { name: /Working tree/ })).not.toHaveAttribute(
      'aria-current',
    );
  });
});

describe('HistoryView selection', () => {
  it('selects a commit by its oid when its row is clicked', () => {
    const store = renderWithCommits([makeCommit(1), makeCommit(2)]);

    fireEvent.click(screen.getByRole('button', { name: /Commit 2/ }));

    expect(selectCommitMock).toHaveBeenCalledWith(store, makeCommit(2).oid);
  });

  it('selects the working tree with null', () => {
    const store = renderWithCommits([makeCommit(1)]);
    fireEvent.click(screen.getByRole('button', { name: /Commit 1/ }));
    selectCommitMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /Working tree/ }));

    expect(selectCommitMock).toHaveBeenCalledWith(store, null);
  });
});

describe('HistoryView keyboard navigation', () => {
  function pressOnList(key: string): void {
    fireEvent.keyDown(screen.getByRole('group', { name: 'Commits' }), { key });
  }

  it('moves the selection down and up, and focuses the selected row', () => {
    const store = renderWithCommits([makeCommit(1), makeCommit(2)]);

    pressOnList('ArrowDown');
    expect(selectCommitMock).toHaveBeenLastCalledWith(store, makeCommit(1).oid);
    expect(screen.getByRole('button', { name: /Commit 1/ })).toHaveFocus();

    pressOnList('ArrowDown');
    expect(selectCommitMock).toHaveBeenLastCalledWith(store, makeCommit(2).oid);

    pressOnList('ArrowUp');
    expect(selectCommitMock).toHaveBeenLastCalledWith(store, makeCommit(1).oid);
    expect(screen.getByRole('button', { name: /Commit 1/ })).toHaveFocus();
  });

  it('stops at the ends of the list instead of wrapping', () => {
    const store = renderWithCommits([makeCommit(1)]);

    pressOnList('ArrowUp');
    expect(selectCommitMock).toHaveBeenLastCalledWith(store, null);

    pressOnList('ArrowDown');
    pressOnList('ArrowDown');
    expect(selectCommitMock).toHaveBeenLastCalledWith(store, makeCommit(1).oid);
  });

  it('jumps to the working tree with Home and to the last commit with End', () => {
    const commits = [makeCommit(1), makeCommit(2), makeCommit(3)];
    const store = renderWithCommits(commits);

    pressOnList('End');
    expect(selectCommitMock).toHaveBeenLastCalledWith(store, makeCommit(3).oid);

    pressOnList('Home');
    expect(selectCommitMock).toHaveBeenLastCalledWith(store, null);
    expect(screen.getByRole('button', { name: /Working tree/ })).toHaveFocus();
  });
});

describe('HistoryView windowing', () => {
  const manyCommits = Array.from({ length: 2000 }, (_, index) => makeCommit(index));

  it('mounts only a window of a large list', () => {
    renderWithCommits(manyCommits);

    // The fallback viewport is 480px tall: ~11 rows plus overscan, never 2001.
    expect(rowButtons().length).toBeLessThan(40);
    expect(screen.getByRole('button', { name: /Working tree/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Commit 0\b/ })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Commit 500\b/ }),
    ).not.toBeInTheDocument();
  });

  it('reserves the full scroll height so the scrollbar is honest', () => {
    renderWithCommits(manyCommits);
    const spacer = screen.getByRole('group', { name: 'Commits' }).firstElementChild;
    expect(spacer).toHaveStyle({ height: `${2001 * ROW_HEIGHT}px` });
  });

  it('swaps the window when the list is scrolled', () => {
    renderWithCommits(manyCommits);
    const viewport = screen.getByRole('group', { name: 'Commits' });

    fireEvent.scroll(viewport, { target: { scrollTop: 500 * ROW_HEIGHT } });

    expect(screen.getByRole('button', { name: /Commit 500\b/ })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Working tree/ }),
    ).not.toBeInTheDocument();
    expect(rowButtons().length).toBeLessThan(40);
  });

  it('scrolls the keyboard-selected row into view', () => {
    renderWithCommits(manyCommits);
    const viewport = screen.getByRole('group', { name: 'Commits' });

    fireEvent.keyDown(viewport, { key: 'End' });

    const lastRow = screen.getByRole('button', { name: /Commit 1999\b/ });
    expect(lastRow).toBeInTheDocument();
    expect(lastRow).toHaveFocus();
    expect(viewport.scrollTop).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Commit 0\b/ })).not.toBeInTheDocument();
  });
});

describe('HistoryView author pictures', () => {
  const NOREPLY = { authorEmail: '4242+ada@users.noreply.github.com' };

  function renderWithConfig(githubAvatars: boolean, commits: Commit[]): void {
    renderHistory((store) => {
      store.dispatch({
        type: 'config/loaded',
        config: { ...defaultConfig(), githubAvatars },
      });
      store.dispatch({ type: 'commits/loaded', commits });
    });
  }

  it('draws the derived badge and asks the network for nothing by default', () => {
    renderWithConfig(false, [makeCommit(1, NOREPLY)]);
    expect(document.querySelector('image')).toBeNull();
    expect(document.querySelector('text')?.textContent).toBe('A1');
  });

  it('fetches a picture only once the user has opted in', () => {
    renderWithConfig(true, [makeCommit(1, NOREPLY)]);
    expect(document.querySelector('image')?.getAttribute('href')).toBe(
      'https://avatars.githubusercontent.com/u/4242?s=32&v=4',
    );
  });

  it('keeps the badge underneath, so a picture that never loads leaves a face', () => {
    renderWithConfig(true, [makeCommit(1, NOREPLY)]);
    expect(document.querySelector('text')?.textContent).toBe('A1');
  });

  it('asks for nothing when the address does not say who the author is', () => {
    // An ordinary email would need GitHub's API to resolve, which needs an
    // account and would send the address itself.
    renderWithConfig(true, [makeCommit(1)]);
    expect(document.querySelector('image')).toBeNull();
  });
});
