import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../config/schema';
import type { Commit } from '../../git/types';
import { mergeRefInto, selectCommit } from '../../state/actions';
import { StoreProvider } from '../../state/hooks';
import { createStore, type Store } from '../../state/store';
import { subscribeOpenRequests } from '../../state/openRequests';
import { HistoryView, ROW_HEIGHT } from './HistoryView';
import { resetAvatarCache } from './avatarCache';
import { sha256Hex } from './remoteAvatar';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

vi.mock('../../state/actions', () => ({
  selectCommit: vi.fn(),
  mergeRefInto: vi.fn(),
}));

const selectCommitMock = vi.mocked(selectCommit);
const mergeRefIntoMock = vi.mocked(mergeRefInto);

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
  mergeRefIntoMock.mockReset().mockResolvedValue(true);
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
    // The HEAD chip is folded into the branch it points at: one ✓ chip, not
    // two chips for the same fact.
    expect(
      chips.map((chip) => [chip.getAttribute('data-ref-kind'), chip.textContent]),
    ).toEqual([
      ['branch', '✓main'],
      ['remote-branch', 'origin/main'],
      ['tag', 'v0.1.0'],
    ]);
  });

  it('marks the checked-out branch, and only that one', () => {
    renderWithCommits([
      makeCommit(1, {
        refs: [
          { kind: 'head', name: 'HEAD' },
          { kind: 'branch', name: 'main' },
          { kind: 'branch', name: 'release' },
        ],
      }),
    ]);

    const row = screen.getByRole('button', { name: /Commit 1/ });
    const current = [...row.querySelectorAll('[data-current="true"]')];
    expect(current.map((chip) => chip.textContent)).toEqual(['✓main']);
    expect(row).toHaveAttribute('data-head', 'true');
  });

  it('keeps the HEAD chip, marked, when the checkout is detached', () => {
    renderWithCommits([
      makeCommit(1, {
        refs: [
          { kind: 'head', name: 'HEAD' },
          { kind: 'tag', name: 'v0.1.0' },
        ],
      }),
    ]);

    const row = screen.getByRole('button', { name: /Commit 1/ });
    const chips = [...row.querySelectorAll('[data-ref-kind]')];
    expect(
      chips.map((chip) => [chip.getAttribute('data-ref-kind'), chip.textContent]),
    ).toEqual([
      ['head', '✓HEAD'],
      ['tag', 'v0.1.0'],
    ]);
  });

  it('marks the HEAD row whether or not it is the selected one', () => {
    renderWithCommits([
      makeCommit(1),
      makeCommit(2, {
        refs: [
          { kind: 'head', name: 'HEAD' },
          { kind: 'branch', name: 'main' },
        ],
      }),
    ]);

    // Selection starts on the working tree, so nothing else is highlighted.
    const head = screen.getByRole('button', { name: /Commit 2/ });
    expect(head).toHaveAttribute('data-head', 'true');
    expect(head).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: /Commit 1/ })).not.toHaveAttribute(
      'data-head',
    );

    fireEvent.click(head);
    expect(screen.getByRole('button', { name: /Commit 2/ })).toHaveAttribute(
      'data-head',
      'true',
    );
  });

  it('names the checked-out branch in the row label, once', () => {
    renderWithCommits([
      makeCommit(1, {
        refs: [
          { kind: 'head', name: 'HEAD' },
          { kind: 'branch', name: 'main' },
        ],
      }),
    ]);

    const row = screen.getByRole('button', { name: /Commit 1/ });
    const label = row.getAttribute('aria-label') ?? '';
    expect(label).toContain('checked out branch main');
    expect(label).not.toContain('HEAD');
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
  /** A one-pixel PNG's worth of bytes; only their round trip matters here. */
  const PIXEL = [137, 80, 78, 71];
  const PIXEL_URL = 'data:image/png;base64,iVBORw==';

  function renderWithConfig(remoteAvatars: boolean, commits: Commit[]): void {
    renderHistory((store) => {
      store.dispatch({
        type: 'config/loaded',
        config: { ...defaultConfig(), remoteAvatars },
      });
      store.dispatch({ type: 'commits/loaded', commits });
    });
  }

  beforeEach(() => {
    resetAvatarCache();
    invoke.mockReset();
    // Nothing is cached, and every write succeeds.
    invoke.mockResolvedValue(null);
  });

  it('draws the derived badge and asks the network for nothing by default', async () => {
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);

    renderWithConfig(false, [makeCommit(1, NOREPLY)]);
    await vi.waitFor(() => {
      expect(document.querySelector('text')?.textContent).toBe('A1');
    });

    expect(fetched).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(document.querySelector('image')).toBeNull();
  });

  it('draws the fetched picture once the user has opted in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array(PIXEL), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      ),
    );

    renderWithConfig(true, [makeCommit(1, NOREPLY)]);

    await vi.waitFor(() => {
      expect(document.querySelector('image')?.getAttribute('href')).toBe(PIXEL_URL);
    });
  });

  it('keeps the badge underneath, so a picture that never loads leaves a face', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    renderWithConfig(true, [makeCommit(1, NOREPLY)]);

    await vi.waitFor(() => {
      expect(document.querySelector('text')?.textContent).toBe('A1');
    });
    expect(document.querySelector('image')).toBeNull();
  });

  it('draws nothing over the badge for an author with no picture anywhere', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
    );

    renderWithConfig(true, [makeCommit(1)]);

    await vi.waitFor(() => {
      expect(document.querySelector('text')?.textContent).toBe('A1');
    });
    expect(document.querySelector('image')).toBeNull();
  });

  it('asks about the authors on screen and no others', async () => {
    // The window is what bounds the lookups: a repository with ten thousand
    // commits must not resolve ten thousand identities to draw thirty rows.
    const fetched = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetched);

    renderWithConfig(
      true,
      Array.from({ length: 2000 }, (_unused, index) => makeCommit(index)),
    );

    await vi.waitFor(() => {
      expect(fetched.mock.calls.length).toBeGreaterThan(0);
    });
    const asked = fetched.mock.calls.map((call) => String(call[0])).join(' ');

    expect(fetched.mock.calls.length).toBeLessThan(100);
    // The author of the last commit is nowhere near the window, so their
    // identity must not have been hashed onto the network.
    expect(asked).not.toContain(await sha256Hex('author1999@example.com'));
    expect(asked).toContain(await sha256Hex('author0@example.com'));
  });
});

describe('dragging a branch onto the checkout', () => {
  /** A row whose refs are HEAD -> main, i.e. the checked-out branch. */
  function headRow(index: number): Commit {
    return makeCommit(index, {
      refs: [
        { kind: 'head', name: 'HEAD' },
        { kind: 'branch', name: 'main' },
      ],
    });
  }

  function branchRow(index: number, name: string): Commit {
    return makeCommit(index, { refs: [{ kind: 'branch', name }] });
  }

  function transfer(): {
    setData: () => void;
    effectAllowed: string;
    dropEffect: string;
  } {
    return { setData: () => {}, effectAllowed: '', dropEffect: '' };
  }

  function dragChip(from: HTMLElement, onto: HTMLElement): void {
    const dataTransfer = transfer();
    fireEvent.dragStart(from, { dataTransfer });
    fireEvent.dragOver(onto, { dataTransfer });
    fireEvent.drop(onto, { dataTransfer });
  }

  function chips(): { source: HTMLElement; target: HTMLElement } {
    return {
      source: screen.getByTitle(/^branch feature\/x/),
      target: screen.getByTitle('checked out branch main'),
    };
  }

  it('asks before merging, naming both ends', () => {
    renderWithCommits([headRow(1), branchRow(2, 'feature/x')]);
    const { source, target } = chips();

    dragChip(source, target);

    const dialog = screen.getByRole('dialog', { name: 'Merge feature/x into main?' });
    expect(within(dialog).getByText(/Merge feature\/x into main\./)).toBeInTheDocument();
    expect(mergeRefIntoMock).not.toHaveBeenCalled();
  });

  it('merges what the question said, with the question as the reason', async () => {
    renderWithCommits([headRow(1), branchRow(2, 'feature/x')]);
    const { source, target } = chips();
    dragChip(source, target);

    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));

    // The string the user read is the string the git layer records: the token
    // it validates is literally what they agreed to.
    expect(mergeRefIntoMock).toHaveBeenCalledTimes(1);
    // The question stays up, with both buttons dead, until the merge lands: a
    // second click in that window would run it twice against one answer.
    expect(screen.getByRole('button', { name: 'Merge' })).toBeDisabled();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const call = mergeRefIntoMock.mock.calls[0];
    expect(call?.[1]).toBe('main');
    expect(call?.[2]).toBe('feature/x');
    expect(call?.[3]).toBe('feature/x');
    expect(call?.[4]).toContain('Merge feature/x into main');
  });

  it('cancels without merging anything', () => {
    renderWithCommits([headRow(1), branchRow(2, 'feature/x')]);
    const { source, target } = chips();
    dragChip(source, target);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mergeRefIntoMock).not.toHaveBeenCalled();
  });

  it('only lets go of a branch over the checked-out one', () => {
    renderWithCommits([headRow(1), branchRow(2, 'feature/x'), branchRow(3, 'feature/y')]);
    const dataTransfer = transfer();
    const source = screen.getByTitle(/^branch feature\/x/);
    const other = screen.getByTitle(/^branch feature\/y/);

    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.drop(other, { dataTransfer });

    // Dropping onto another branch would mean checking it out first, which is
    // not something a 200px gesture should do to somebody's working tree.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ignores a drop that no drag of ours started', () => {
    renderWithCommits([headRow(1), branchRow(2, 'feature/x')]);
    fireEvent.drop(screen.getByTitle('checked out branch main'), {
      dataTransfer: transfer(),
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('marks branch chips draggable and the checkout as the place to drop', () => {
    renderWithCommits([headRow(1), branchRow(2, 'feature/x')]);
    const { source, target } = chips();

    expect(source).toHaveAttribute('draggable', 'true');
    expect(source).toHaveAttribute('title', expect.stringContaining('drag onto'));
    expect(target).toHaveAttribute('data-drop-target', 'true');
    // The checkout is not a thing you pick up: merging it into itself is the
    // one merge that can never mean anything.
    expect(target).not.toHaveAttribute('draggable');
  });

  it('does not make a tag draggable', () => {
    renderWithCommits([
      headRow(1),
      makeCommit(2, { refs: [{ kind: 'tag', name: 'v1.0' }] }),
    ]);
    expect(screen.getByTitle('tag v1.0')).not.toHaveAttribute('draggable');
  });
});

describe('another checkout on the timeline', () => {
  const WIKI = 'C:/repos/app-wiki';

  function worktree(overrides: Record<string, unknown> = {}) {
    return {
      path: WIKI,
      head: `${2}`.padStart(40, 'a'),
      branch: 'wiki',
      detached: false,
      bare: false,
      locked: null,
      prunable: null,
      main: false,
      changed: 3,
      untracked: 2,
      ...overrides,
    };
  }

  function renderWithWorktree(overrides: Record<string, unknown> = {}): Store {
    return renderHistory((store) => {
      store.dispatch({
        type: 'commits/loaded',
        commits: [makeCommit(1), makeCommit(2)],
      });
      store.dispatch({
        type: 'worktrees/loaded',
        worktrees: [worktree(overrides)] as never,
      });
    });
  }

  it('draws a WIP row above the commit that worktree has checked out', () => {
    renderWithWorktree();
    // Only the rows themselves: the "Open Worktree" control inside one is a
    // button too, and counting it would shift every index after it.
    const rows = rowButtons()
      .filter((row) => row.hasAttribute('data-index'))
      .map((row) => row.getAttribute('aria-label') ?? '');
    const wip = rows.findIndex((label) => label.startsWith('Worktree app-wiki'));
    const commit = rows.findIndex((label) => label.includes('Commit 2'));

    expect(wip).toBeGreaterThan(-1);
    expect(wip).toBe(commit - 1);
  });

  it('says how much is uncommitted over there', () => {
    renderWithWorktree();
    expect(screen.getByText('3 changed')).toBeInTheDocument();
    expect(screen.getByText('+2 new')).toBeInTheDocument();
  });

  it('says a clean worktree is clean rather than showing nothing', () => {
    renderWithWorktree({ changed: 0, untracked: 0 });
    expect(screen.getByText('clean')).toBeInTheDocument();
  });

  it('admits when the other checkout could not be read', () => {
    renderWithWorktree({ changed: null, untracked: null });
    expect(screen.getByText('could not be read')).toBeInTheDocument();
  });

  it('asks the app to open that directory, without touching this checkout', () => {
    const opened: string[] = [];
    renderWithWorktree();
    const stop = subscribeOpenRequests((path) => {
      opened.push(path);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open Worktree' }));

    expect(opened).toEqual([WIKI]);
    stop();
  });

  it('never selects the WIP row: there is no commit to show a diff of', () => {
    renderWithWorktree();
    const wip = rowButtons().find(
      (row) =>
        row.hasAttribute('data-index') &&
        (row.getAttribute('aria-label') ?? '').startsWith('Worktree app-wiki'),
    );
    if (wip === undefined) throw new Error('no worktree row');

    fireEvent.click(wip);

    // Asking git about `worktree:C:/repos/app-wiki` is asking about a sha that
    // does not exist, so the click moves nothing.
    expect(selectCommitMock).not.toHaveBeenCalled();
  });
});
