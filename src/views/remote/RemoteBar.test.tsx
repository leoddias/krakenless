import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Branch, RepoStatus } from '../../git/types';
import {
  fetchRemote,
  pullCurrent,
  pushCurrent,
  refreshBranches,
} from '../../state/actions';
import { StoreProvider } from '../../state/hooks';
import { createStore, type Store } from '../../state/store';
import { RemoteBar } from './RemoteBar';

vi.mock('../../state/actions', () => ({
  fetchRemote: vi.fn(),
  pullCurrent: vi.fn(),
  pushCurrent: vi.fn(),
  refreshBranches: vi.fn(),
}));

const fetchMock = vi.mocked(fetchRemote);
const pullMock = vi.mocked(pullCurrent);
const pushMock = vi.mocked(pushCurrent);
const refreshBranchesMock = vi.mocked(refreshBranches);

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue(true);
  pullMock.mockResolvedValue(true);
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

  it('says up to date rather than showing two zeroes', () => {
    renderReady({ upstream: 'origin/main' });
    expect(screen.getByText(/Up to date with its upstream/)).toBeInTheDocument();
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
    expect(screen.getByText(/Krakenless never force-pushes/)).toBeInTheDocument();
  });
});

describe('RemoteBar — publishing a branch with no upstream', () => {
  it('offers publish and sets the upstream', async () => {
    const store = renderReady({ upstream: undefined }, [remoteBranch('origin/main')]);
    expect(screen.getByText('main — no upstream')).toBeInTheDocument();
    expect(screen.getByText(/Creates origin\/main and sets it/)).toBeInTheDocument();

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
