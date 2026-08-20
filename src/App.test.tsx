import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { StoreProvider } from './state/hooks';
import { createStore, type Store } from './state/store';
import type { RepoInfo } from './git/types';

const loadConfig = vi.hoisted(() => vi.fn());
const watchRepository = vi.hoisted(() => vi.fn());

vi.mock('./config/store', () => ({
  loadConfig,
  saveConfig: vi.fn(),
  configFolder: vi.fn(),
}));
vi.mock('./state/watch', () => ({ watchRepository }));
// The views have their own tests; here we only care that the shell mounts the
// right one and wires the watcher.
vi.mock('./views/welcome', () => ({ WelcomeView: () => <div>welcome view</div> }));
vi.mock('./views/history/HistoryView', () => ({
  HistoryView: () => <div>history view</div>,
}));
vi.mock('./views/diff', () => ({ DiffView: () => <div>diff view</div> }));
vi.mock('./views/changes', () => ({ ChangesView: () => <div>changes view</div> }));
vi.mock('./views/settings', () => ({
  SettingsView: ({ onClose }: { onClose: () => void }) => (
    <button type="button" onClick={onClose}>
      settings view
    </button>
  ),
}));

const REPO: RepoInfo = {
  root: 'C:/repos/app',
  gitDir: 'C:/repos/app/.git',
  bare: false,
  empty: false,
};

function renderApp(store: Store) {
  return render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
}

describe('App', () => {
  const stop = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    loadConfig.mockResolvedValue({
      version: 1,
      recentRepos: [],
      editorCommand: '',
      mergetool: '',
      theme: 'dark',
    });
    watchRepository.mockResolvedValue({ stop });
  });

  it('shows the welcome view until a repository is open', () => {
    renderApp(createStore());
    expect(screen.getByText('welcome view')).toBeInTheDocument();
    expect(screen.queryByText('history view')).not.toBeInTheDocument();
  });

  it('shows the repository panels once one is open', () => {
    const store = createStore();
    store.dispatch({ type: 'repo/opened', repo: REPO });
    renderApp(store);

    expect(screen.getByText('history view')).toBeInTheDocument();
    expect(screen.getByText('changes view')).toBeInTheDocument();
    expect(screen.getByText('diff view')).toBeInTheDocument();
    expect(screen.getByText('C:/repos/app')).toBeInTheDocument();
  });

  it('loads saved settings on startup', async () => {
    const store = createStore();
    renderApp(store);
    await waitFor(() => expect(loadConfig).toHaveBeenCalled());
  });

  it('watches the open repository and stops watching when it closes', async () => {
    const store = createStore();
    store.dispatch({ type: 'repo/opened', repo: REPO });
    renderApp(store);

    await waitFor(() => expect(watchRepository).toHaveBeenCalledWith(store, REPO.root));

    store.dispatch({ type: 'repo/closed' });
    await waitFor(() => expect(stop).toHaveBeenCalled());
  });

  it('surfaces a notice, with its undo command, above the panels', () => {
    const store = createStore();
    store.dispatch({ type: 'repo/opened', repo: REPO });
    store.dispatch({
      type: 'notice',
      notice: {
        tone: 'info',
        message: 'Discarded changes to 1 file(s).',
        undoHint: 'git restore --source=abc123 --worktree -- "a.txt"',
      },
    });
    renderApp(store);

    expect(screen.getByRole('status')).toHaveTextContent('Discarded changes');
    expect(
      screen.getByText('git restore --source=abc123 --worktree -- "a.txt"'),
    ).toBeInTheDocument();
  });

  it('opens settings and comes back to the panels', () => {
    const store = createStore();
    store.dispatch({ type: 'repo/opened', repo: REPO });
    renderApp(store);

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByText('settings view')).toBeInTheDocument();
    expect(screen.queryByText('history view')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'settings view' }));
    expect(screen.getByText('history view')).toBeInTheDocument();
  });

  it('shows the branch and ahead/behind counters', () => {
    const store = createStore();
    store.dispatch({ type: 'repo/opened', repo: REPO });
    store.dispatch({
      type: 'status/loaded',
      status: {
        branch: 'main',
        head: 'abc',
        detached: false,
        upstream: 'origin/main',
        ahead: 2,
        behind: 1,
        entries: [],
        hasConflicts: false,
      },
    });
    renderApp(store);

    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByTitle('ahead')).toHaveTextContent('2');
    expect(screen.getByTitle('behind')).toHaveTextContent('1');
  });

  it('says the head is detached rather than showing a missing branch name', () => {
    const store = createStore();
    store.dispatch({ type: 'repo/opened', repo: REPO });
    store.dispatch({
      type: 'status/loaded',
      status: {
        branch: null,
        head: 'abc',
        detached: true,
        ahead: 0,
        behind: 0,
        entries: [],
        hasConflicts: false,
      },
    });
    renderApp(store);

    expect(screen.getByText('detached HEAD')).toBeInTheDocument();
  });

  it('flags conflicts in the header', () => {
    const store = createStore();
    store.dispatch({ type: 'repo/opened', repo: REPO });
    store.dispatch({
      type: 'status/loaded',
      status: {
        branch: 'main',
        head: 'abc',
        detached: false,
        ahead: 0,
        behind: 0,
        entries: [],
        hasConflicts: true,
      },
    });
    renderApp(store);

    expect(screen.getByText('conflicts')).toBeInTheDocument();
  });

  it('says status is unavailable instead of pretending it is clean', () => {
    const store = createStore();
    store.dispatch({ type: 'repo/opened', repo: REPO });
    store.dispatch({
      type: 'status/failed',
      message: 'git status timed out',
      kind: 'timeout',
    });
    renderApp(store);

    expect(screen.getByText('status unavailable')).toBeInTheDocument();
  });
});
