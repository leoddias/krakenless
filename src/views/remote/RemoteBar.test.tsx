import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Branch, RepoStatus } from '../../git/types';
import {
  fetchRemote,
  pullCurrent,
  pullMergeCurrent,
  pushCurrent,
  refreshBranches,
} from '../../state/actions';
import { StoreProvider } from '../../state/hooks';
import { createStore, type Store } from '../../state/store';
import { RemoteBar } from './RemoteBar';

vi.mock('../../state/actions', () => ({
  fetchRemote: vi.fn(),
  pullCurrent: vi.fn(),
  pullMergeCurrent: vi.fn(),
  pushCurrent: vi.fn(),
  refreshBranches: vi.fn(),
}));

const fetchMock = vi.mocked(fetchRemote);
const pullMock = vi.mocked(pullCurrent);
const pullMergeMock = vi.mocked(pullMergeCurrent);
const pushMock = vi.mocked(pushCurrent);
const refreshBranchesMock = vi.mocked(refreshBranches);

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue(true);
  pullMock.mockResolvedValue(true);
  pullMergeMock.mockResolvedValue('pulled');
  pushMock.mockResolvedValue(true);
  refreshBranchesMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

function statusOf(overrides: Partial<RepoStatus> = {}): RepoStatus {
  return {
    branch: 'main',
    head: 'a'.repeat(40),
    detached: false,
    ahead: 0,
    behind: 0,
    entries: [],
    hasConflicts: false,
    ...overrides,
  };
}

function remoteBranch(name: string): Branch {
  return { name, current: false, oid: 'b'.repeat(40), ahead: 0, behind: 0, remote: true };
}

function openRepo(store: Store): void {
  store.dispatch({
    type: 'repo/opened',
    repo: { root: '/repo', gitDir: '/repo/.git', bare: false, empty: false },
  });
}

function renderBar(prepare: (store: Store) => void = () => {}): Store {
  const store = createStore();
  prepare(store);
  render(
    <StoreProvider store={store}>
      <RemoteBar />
    </StoreProvider>,
  );
  return store;
}

/** Repository open, status read, branch list read — the ordinary case. */
function renderReady(
  status: Partial<RepoStatus> = { upstream: 'origin/main' },
  branches: Branch[] = [remoteBranch('origin/main')],
): Store {
  return renderBar((store) => {
    // `repo/opened` resets derived state, so it has to come first.
    openRepo(store);
    store.dispatch({ type: 'status/loaded', status: statusOf(status) });
    store.dispatch({ type: 'branches/loaded', branches });
  });
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name });
}

describe('RemoteBar — panel states', () => {
  it('says no repository is open and disables every action', () => {
    renderBar();
    expect(screen.getByText('No repository open')).toBeInTheDocument();
    expect(button('Fetch')).toBeDisabled();
    expect(button('Pull')).toBeDisabled();
    expect(button('Push')).toBeDisabled();
    expect(screen.getAllByText('No repository is open.').length).toBe(3);
  });

  it('shows a loading state without inventing counts', () => {
    renderBar((store) => {
      openRepo(store);
      store.dispatch({ type: 'status/loading' });
    });
    expect(screen.getByText('Reading branch status…')).toBeInTheDocument();
    expect(button('Pull')).toBeDisabled();
    expect(button('Push')).toBeDisabled();
    expect(screen.getAllByText(/Waiting for the branch status/).length).toBe(2);
    expect(screen.queryByText(/ahead/)).not.toBeInTheDocument();
  });

  it('shows a failed status read and refuses to act on it', () => {
    renderBar((store) => {
      openRepo(store);
      store.dispatch({ type: 'status/failed', message: 'git exploded', kind: 'timeout' });
    });
    expect(screen.getByText('Branch status unavailable')).toBeInTheDocument();
    expect(screen.getByText(/git exploded/)).toBeInTheDocument();
    expect(button('Pull')).toBeDisabled();
    expect(button('Push')).toBeDisabled();
    expect(screen.getAllByText(/status could not be read/).length).toBe(2);
    // Fetch is read-only, so a failed status read does not block it.
    expect(button('Fetch')).toBeEnabled();
  });

  it('renders the ahead and behind counts of the current branch', () => {
    renderReady({ upstream: 'origin/main', ahead: 2, behind: 3 });
    expect(screen.getByText('main → origin/main')).toBeInTheDocument();
    expect(screen.getByText(/2 ahead, 3 behind/)).toBeInTheDocument();
  });

  it('says what git reported rather than showing two zeroes', () => {
    renderReady({ upstream: 'origin/main' });
    expect(
      screen.getByText(/Git reported no commits on either side/),
    ).toBeInTheDocument();
  });
});

describe('RemoteBar — actions', () => {
  it('fetches through the action layer', async () => {
    const store = renderReady();
    await act(async () => {
      fireEvent.click(button('Fetch'));
    });
    expect(fetchMock).toHaveBeenCalledWith(store);
    expect(screen.getByText(/Fetch finished/)).toBeInTheDocument();
  });

  it('pulls through the action layer', async () => {
    const store = renderReady();
    await act(async () => {
      fireEvent.click(button('Pull'));
    });
    expect(pullMock).toHaveBeenCalledWith(store);
    expect(screen.getByText(/Pull finished/)).toBeInTheDocument();
  });

  it('pushes to the upstream remote without setting it again', async () => {
    const store = renderReady({ upstream: 'origin/main', ahead: 1 });
    await act(async () => {
      fireEvent.click(button('Push'));
    });
    expect(pushMock).toHaveBeenCalledWith(store, { remote: 'origin', branch: 'main' });
    expect(screen.getByText('Push finished.')).toBeInTheDocument();
  });

  it('never offers a force push, even on a diverged branch', () => {
    renderReady({ upstream: 'origin/main', ahead: 1, behind: 1 });
    for (const control of screen.getAllByRole('button')) {
      expect(control).not.toHaveAccessibleName(/force/i);
    }
    // Divergence resolves through the merge-pull, never through force: push
    // is blocked outright and the way out is spelled next to it.
    expect(button('Pull (merge)')).toBeEnabled();
    expect(screen.getByText(/Pull first, then push/)).toBeInTheDocument();
  });

  it('still names the no-force promise while push is offered', () => {
    renderReady({ upstream: 'origin/main', ahead: 1 });
    expect(button('Push')).toBeEnabled();
    expect(screen.getByText(/Krakenless never force-pushes/)).toBeInTheDocument();
  });
});

describe('RemoteBar — publishing a branch with no upstream', () => {
  it('offers publish and sets the upstream', async () => {
    const store = renderReady({ upstream: undefined }, [remoteBranch('origin/main')]);
    expect(screen.getByText('main — no upstream')).toBeInTheDocument();
    expect(
      screen.getByText(/Pushes main to origin and sets origin\/main/),
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(button('Publish branch'));
    });
    expect(pushMock).toHaveBeenCalledWith(store, {
      remote: 'origin',
      branch: 'main',
      setUpstream: true,
    });
    expect(
      screen.getByText(/Branch published and set as the upstream/),
    ).toBeInTheDocument();
  });

  it('lets the user choose between several known remotes', async () => {
    const store = renderReady({ branch: 'topic', upstream: undefined }, [
      remoteBranch('origin/main'),
      remoteBranch('fork/main'),
    ]);
    const select = screen.getByLabelText('Publish to');
    fireEvent.change(select, { target: { value: 'fork' } });

    await act(async () => {
      fireEvent.click(button('Publish branch'));
    });
    expect(pushMock).toHaveBeenCalledWith(store, {
      remote: 'fork',
      branch: 'topic',
      setUpstream: true,
    });
  });

  it('always offers the remote choice, even when it knows only one', () => {
    // The remote set is reconstructed from the branch list, so a silent default
    // could publish to a remote the user was never shown.
    renderReady({ upstream: undefined }, [remoteBranch('internal/main')]);
    const select = screen.getByLabelText('Publish to');
    expect(select).toHaveValue('internal');
  });

  it('does not blame a missing remote while the branch list is still unread', () => {
    renderBar((store) => {
      openRepo(store);
      store.dispatch({ type: 'status/loaded', status: statusOf() });
    });
    expect(button('Publish branch')).toBeDisabled();
    expect(screen.getByText(/Reading the list of remotes/)).toBeInTheDocument();
    expect(screen.queryByText(/git remote add/)).not.toBeInTheDocument();
  });

  it('says the branch list failed instead of claiming there is no remote', () => {
    renderBar((store) => {
      openRepo(store);
      store.dispatch({ type: 'status/loaded', status: statusOf() });
      store.dispatch({ type: 'branches/failed', message: 'no branches for you' });
    });
    expect(button('Publish branch')).toBeDisabled();
    expect(screen.getByText(/does not know which remotes exist/)).toBeInTheDocument();
    expect(screen.queryByText(/git remote add/)).not.toBeInTheDocument();
  });

  it('refuses to publish when it knows of no remote', () => {
    renderReady({ upstream: undefined }, []);
    expect(button('Publish branch')).toBeDisabled();
    expect(screen.getByText(/knows of no remote to publish to/)).toBeInTheDocument();
  });

  it('blocks pull on a branch that tracks nothing', () => {
    renderReady({ upstream: undefined });
    expect(button('Pull')).toBeDisabled();
    expect(screen.getByText(/no upstream\. Publish it first/)).toBeInTheDocument();
  });

  it('reads the branch list when it has not been loaded yet', async () => {
    const store = renderBar((prepared) => {
      openRepo(prepared);
      prepared.dispatch({ type: 'status/loaded', status: statusOf() });
    });
    await waitFor(() => expect(refreshBranchesMock).toHaveBeenCalledWith(store));
  });
});

describe('RemoteBar — refusals', () => {
  it('disables pull and push on a detached HEAD, with the reason in text', () => {
    renderReady({ branch: null, detached: true, upstream: undefined });
    expect(screen.getByText('Detached HEAD')).toBeInTheDocument();
    expect(button('Pull')).toBeDisabled();
    expect(button('Push')).toBeDisabled();
    expect(screen.getAllByText(/HEAD is detached/).length).toBe(2);
    expect(button('Fetch')).toBeEnabled();
  });

  it('disables pull and push while a merge has unresolved conflicts', () => {
    renderReady({ upstream: 'origin/main', hasConflicts: true });
    expect(button('Pull')).toBeDisabled();
    expect(button('Push')).toBeDisabled();
    expect(screen.getAllByText(/A merge is in progress/).length).toBe(2);
    expect(button('Fetch')).toBeEnabled();
  });

  it('disables everything while the store is busy', () => {
    renderBar((store) => {
      openRepo(store);
      store.dispatch({
        type: 'status/loaded',
        status: statusOf({ upstream: 'origin/main' }),
      });
      store.dispatch({
        type: 'branches/loaded',
        branches: [remoteBranch('origin/main')],
      });
      store.dispatch({ type: 'busy', busy: true });
    });
    expect(button('Fetch')).toBeDisabled();
    expect(button('Pull')).toBeDisabled();
    expect(button('Push')).toBeDisabled();
    expect(screen.getAllByText(/Another git operation is already running/).length).toBe(
      3,
    );
  });

  it('refuses to push a branch whose upstream has a different name', () => {
    renderReady({ upstream: 'origin/trunk', ahead: 1 });
    expect(button('Push')).toBeDisabled();
    expect(screen.getByText(/git push origin main:trunk/)).toBeInTheDocument();
  });
});

describe('RemoteBar — honesty about failure', () => {
  it('marks the running action on the button, not by reloading the window', () => {
    // A pull re-reads several panels. Blanking them all is how a two-second
    // fetch turns into the whole window reloading; the answer to "is it doing
    // anything?" belongs on the control that was pressed.
    let finish = (): void => {};
    pullMock.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = () => resolve(true);
        }),
    );
    renderReady();

    fireEvent.click(button('Pull'));

    const spinner = button('Pull').querySelector('svg');
    expect(spinner?.getAttribute('class')).toMatch(/spinner/);

    act(() => finish());
  });

  it('does not report success when the action layer returns false', async () => {
    pushMock.mockResolvedValue(false);
    renderReady({ upstream: 'origin/main', ahead: 1 });

    await act(async () => {
      fireEvent.click(button('Push'));
    });
    expect(screen.queryByText('Push finished.')).not.toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Push did not complete. Nothing was published.');
  });

  it('does not report a fast-forward that never happened', async () => {
    pullMock.mockResolvedValue(false);
    renderReady({ upstream: 'origin/main', behind: 2 });

    await act(async () => {
      fireEvent.click(button('Pull'));
    });
    expect(screen.queryByText(/Pull finished/)).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Pull did not complete, and your branch was left as it was.',
    );
  });

  it('treats a thrown action as a failure too', async () => {
    fetchMock.mockRejectedValue(new Error('unexpected'));
    renderReady();

    await act(async () => {
      fireEvent.click(button('Fetch'));
    });
    expect(screen.queryByText(/Fetch finished/)).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Fetch did not complete.');
    // The error text itself stays in the shell's notice, not duplicated here.
    expect(screen.queryByText(/unexpected/)).not.toBeInTheDocument();
  });

  it('drops the outcome when another repository is opened', async () => {
    const store = renderReady({ upstream: 'origin/main', ahead: 1 });
    await act(async () => {
      fireEvent.click(button('Push'));
    });
    expect(screen.getByText('Push finished.')).toBeInTheDocument();

    act(() => {
      store.dispatch({
        type: 'repo/opened',
        repo: { root: '/other', gitDir: '/other/.git', bare: false, empty: false },
      });
    });
    expect(screen.queryByText('Push finished.')).not.toBeInTheDocument();
  });

  it('drops the outcome once the panel describes a different branch', async () => {
    const store = renderReady({ upstream: 'origin/main', ahead: 1 });
    await act(async () => {
      fireEvent.click(button('Push'));
    });
    expect(screen.getByText('Push finished.')).toBeInTheDocument();

    act(() => {
      store.dispatch({
        type: 'status/loaded',
        status: statusOf({ branch: 'topic', upstream: 'origin/topic' }),
      });
    });
    expect(screen.queryByText('Push finished.')).not.toBeInTheDocument();
  });

  it('clears the previous outcome when a new operation starts', async () => {
    fetchMock.mockResolvedValue(false);
    renderReady();
    await act(async () => {
      fireEvent.click(button('Fetch'));
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fetchMock.mockResolvedValue(true);
    await act(async () => {
      fireEvent.click(button('Fetch'));
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(/Fetch finished/)).toBeInTheDocument();
  });
});

describe('RemoteBar — a diverged branch', () => {
  const diverged = { upstream: 'origin/main', ahead: 2, behind: 3 };

  it('turns Pull into the merge-pull and blocks Push with the way out', () => {
    renderReady(diverged);
    expect(button('Pull (merge)')).toBeEnabled();
    expect(button('Push')).toBeDisabled();
    expect(screen.getByText(/Pull first, then push/)).toBeInTheDocument();
  });

  it('asks before merging, and runs nothing until the user agrees', async () => {
    renderReady(diverged);
    fireEvent.click(button('Pull (merge)'));

    // The question names both refs and both counts; nothing has run yet.
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(/origin\/main/);
    expect(dialog).toHaveTextContent(/2 commits/);
    expect(pullMergeMock).not.toHaveBeenCalled();
    expect(pullMock).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(button('Pull and merge'));
    });
    expect(pullMergeMock).toHaveBeenCalledTimes(1);
    // The confirmation reason is the sentence the user read.
    expect(pullMergeMock.mock.calls[0]?.[1]).toMatch(/merge origin\/main into main/i);
    expect(screen.getByText(/The upstream was merged/)).toBeInTheDocument();
  });

  it('runs nothing when the question is cancelled', () => {
    renderReady(diverged);
    fireEvent.click(button('Pull (merge)'));
    fireEvent.click(button('Cancel'));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(pullMergeMock).not.toHaveBeenCalled();
  });

  it('adds no outcome line for a conflicted stop — the notice and banner narrate it', async () => {
    pullMergeMock.mockResolvedValue('conflicted');
    renderReady(diverged);
    fireEvent.click(button('Pull (merge)'));
    await act(async () => {
      fireEvent.click(button('Pull and merge'));
    });
    expect(screen.queryByText(/Pull finished/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reports a failed merge-pull as one', async () => {
    pullMergeMock.mockResolvedValue(null);
    renderReady(diverged);
    fireEvent.click(button('Pull (merge)'));
    await act(async () => {
      fireEvent.click(button('Pull and merge'));
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/Pull did not complete/);
  });
});

describe('RemoteBar — a branch merely behind', () => {
  it('keeps the fast-forward pull and blocks only the push', () => {
    renderReady({ upstream: 'origin/main', ahead: 0, behind: 2 });
    expect(button('Pull')).toBeEnabled();
    expect(button('Push')).toBeDisabled();
    expect(screen.getByText(/2 commits this branch does not/)).toBeInTheDocument();
  });
});
