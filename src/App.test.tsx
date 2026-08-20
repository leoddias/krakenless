import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { StoreProvider, useStore } from './state/hooks';
import { createStore, type Store } from './state/store';
import type { RepoInfo } from './git/types';
import { LAYOUT_BOUNDS, defaultConfig } from './config/schema';

const loadConfig = vi.hoisted(() => vi.fn());
const saveConfig = vi.hoisted(() => vi.fn());
const watchRepository = vi.hoisted(() => vi.fn());
const refreshAllPanels = vi.hoisted(() => vi.fn());

vi.mock('./config/store', () => ({
  loadConfig,
  saveConfig,
  configFolder: vi.fn(),
}));
vi.mock('./state/watch', () => ({ watchRepository }));
vi.mock('./state/actions', async (original) => ({
  ...(await original<typeof import('./state/actions')>()),
  refreshAllPanels,
}));
// The views have their own tests; here we only care that the shell mounts the
// right one and wires the watcher.
vi.mock('./views/welcome', () => ({
  // The real screen opens a repository into the store it is rendered under;
  // this one does the same thing with a button, so the tab machinery above it
  // is exercised for real.
  WelcomeView: () => {
    const store = useStore();
    return (
      <div>
        welcome view
        <button
          type="button"
          onClick={() =>
            store.dispatch({
              type: 'repo/opened',
              repo: { ...REPO, root: 'C:/repos/other', gitDir: 'C:/repos/other/.git' },
            })
          }
        >
          open other
        </button>
        <button
          type="button"
          onClick={() => store.dispatch({ type: 'repo/opened', repo: REPO })}
        >
          open app again
        </button>
      </div>
    );
  },
}));
vi.mock('./views/history/HistoryView', () => ({
  HistoryView: () => <div>history view</div>,
}));
vi.mock('./views/diff', () => ({ DiffView: () => <div>diff view</div> }));
vi.mock('./views/changes', () => ({ ChangesView: () => <div>changes view</div> }));
vi.mock('./views/remote', () => ({ RemoteBar: () => <div>remote bar</div> }));
vi.mock('./views/refs', () => ({ RefsView: () => <div>refs view</div> }));
vi.mock('./views/conflicts', () => ({
  ConflictBanner: () => <div>conflict banner</div>,
}));
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
    loadConfig.mockResolvedValue(defaultConfig());
    saveConfig.mockResolvedValue(undefined);
    watchRepository.mockResolvedValue({ stop });
    refreshAllPanels.mockResolvedValue(undefined);
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
    expect(screen.getByText('refs view')).toBeInTheDocument();
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

  it('moves focus into a panel with its shortcut', () => {
    const store = createStore();
    store.dispatch({ type: 'repo/opened', repo: REPO });
    renderApp(store);

    fireEvent.keyDown(window, { key: '3', ctrlKey: true });
    // The panel itself takes focus when it has no focusable control of its own
    // (the views are mocked here), which is still inside the right region.
    expect(document.activeElement?.closest('[aria-label="Working tree"]')).not.toBeNull();
  });

  it('re-reads the repository on the refresh shortcut', () => {
    const store = createStore();
    store.dispatch({ type: 'repo/opened', repo: REPO });
    renderApp(store);

    fireEvent.keyDown(window, { key: 'F5' });
    expect(refreshAllPanels).toHaveBeenCalledWith(store);
  });

  it('closes the repository on its shortcut', () => {
    const store = createStore();
    store.dispatch({ type: 'repo/opened', repo: REPO });
    renderApp(store);

    fireEvent.keyDown(window, { key: 'w', ctrlKey: true });
    expect(store.getState().repo.state).toBe('idle');
  });

  it('ignores shortcuts fired from a text field', () => {
    // Otherwise Ctrl+W in the commit message box would close the repository
    // and take the half-written message with it.
    const store = createStore();
    store.dispatch({ type: 'repo/opened', repo: REPO });
    renderApp(store);

    const input = document.createElement('textarea');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'w', ctrlKey: true });

    expect(store.getState().repo.state).toBe('ready');
    input.remove();
  });

  it('shows the branch, leaving ahead/behind to the remote bar', () => {
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
    // The counts belong to the remote bar, which states what they are relative
    // to ("as of the last fetch"); bare arrows in the header did not.
    expect(screen.queryByTitle('ahead')).not.toBeInTheDocument();
    expect(screen.getByText('remote bar')).toBeInTheDocument();
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

it('offers a refresh the user can find, not only a shortcut', async () => {
  // A filesystem watch can miss a change — a network share, an editor that
  // writes through a temporary file, a burst that overflows the OS buffer.
  // Ctrl+R has always re-read the repository; discovering it at the moment
  // you need it is the hard part.
  const store = createStore();
  store.dispatch({ type: 'repo/opened', repo: REPO });
  renderApp(store);

  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

  await waitFor(() => expect(refreshAllPanels).toHaveBeenCalledWith(store));
});

describe('App layout', () => {
  const stop = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    loadConfig.mockResolvedValue(defaultConfig());
    saveConfig.mockResolvedValue(undefined);
    watchRepository.mockResolvedValue({ stop });
  });

  function openRepo(): Store {
    const store = createStore();
    store.dispatch({ type: 'repo/opened', repo: REPO });
    renderApp(store);
    return store;
  }

  it('offers a draggable edge for each panel it can resize', () => {
    openRepo();
    expect(
      screen.getByRole('separator', { name: 'Resize the branches panel' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('separator', { name: 'Resize the history panel' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('separator', { name: 'Resize the working tree panel' }),
    ).toBeInTheDocument();
  });

  it('remembers a size once the drag finishes, and not on every mouse move', () => {
    const store = openRepo();
    const handle = screen.getByRole('separator', { name: 'Resize the branches panel' });

    fireEvent.mouseDown(handle, { clientX: 264, button: 0 });
    fireEvent.mouseMove(window, { clientX: 300 });
    fireEvent.mouseMove(window, { clientX: 320 });
    // Hundreds of writes per drag is what this avoids.
    expect(saveConfig).not.toHaveBeenCalled();

    fireEvent.mouseUp(window);
    const saved = defaultConfig().layout.sidebarWidth + 56;
    expect(store.getState().config.layout.sidebarWidth).toBe(saved);
    expect(saveConfig).toHaveBeenCalledTimes(1);
  });

  it('drags the working tree panel the other way, since it sits on the right', () => {
    const store = openRepo();
    const handle = screen.getByRole('separator', {
      name: 'Resize the working tree panel',
    });

    fireEvent.mouseDown(handle, { clientX: 900, button: 0 });
    fireEvent.mouseMove(window, { clientX: 960 });
    fireEvent.mouseUp(window);

    expect(store.getState().config.layout.detailWidth).toBe(
      defaultConfig().layout.detailWidth - 60,
    );
  });

  it('refuses to drag a panel past the point where it stops being readable', () => {
    const store = openRepo();
    const handle = screen.getByRole('separator', { name: 'Resize the branches panel' });

    fireEvent.mouseDown(handle, { clientX: 264, button: 0 });
    fireEvent.mouseMove(window, { clientX: 0 });
    fireEvent.mouseUp(window);

    expect(store.getState().config.layout.sidebarWidth).toBe(
      LAYOUT_BOUNDS.sidebarWidth.min,
    );
  });

  it('resizes from the keyboard too', () => {
    const store = openRepo();
    const handle = screen.getByRole('separator', { name: 'Resize the branches panel' });

    fireEvent.keyDown(handle, { key: 'ArrowRight' });

    expect(store.getState().config.layout.sidebarWidth).toBe(
      defaultConfig().layout.sidebarWidth + 16,
    );
  });

  it('keeps the layout when saving it fails, rather than snapping back', () => {
    saveConfig.mockRejectedValue(new Error('disk is full'));
    const store = openRepo();
    const handle = screen.getByRole('separator', { name: 'Resize the branches panel' });

    fireEvent.mouseDown(handle, { clientX: 264, button: 0 });
    fireEvent.mouseMove(window, { clientX: 300 });
    fireEvent.mouseUp(window);

    expect(store.getState().config.layout.sidebarWidth).toBe(
      defaultConfig().layout.sidebarWidth + 36,
    );
  });
});

describe('App tabs', () => {
  const stop = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    loadConfig.mockResolvedValue(defaultConfig());
    saveConfig.mockResolvedValue(undefined);
    watchRepository.mockResolvedValue({ stop });
  });

  function openFirst(): Store {
    const store = createStore();
    store.dispatch({ type: 'repo/opened', repo: REPO });
    renderApp(store);
    return store;
  }

  function tab(name: string): HTMLElement {
    return screen.getByRole('tab', { name: new RegExp(name) });
  }

  it('gives the open repository a tab', () => {
    openFirst();
    expect(tab('app')).toHaveAttribute('aria-selected', 'true');
  });

  it('goes back to the repository list without closing what is open', () => {
    openFirst();

    fireEvent.click(screen.getByRole('button', { name: 'Krakenless' }));

    expect(screen.getByText('welcome view')).toBeInTheDocument();
    // The tab is still there, and still watching.
    expect(tab('app')).toHaveAttribute('aria-selected', 'false');
    expect(stop).not.toHaveBeenCalled();
  });

  it('opens a second repository in its own tab', () => {
    openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Krakenless' }));
    fireEvent.click(screen.getByRole('button', { name: 'open other' }));

    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(tab('other')).toHaveAttribute('aria-selected', 'true');
  });

  it('activates the tab a repository already has instead of opening a second', () => {
    openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Krakenless' }));

    // The same repository, asked for again from the home screen. Two tabs on
    // one repository would mean two watchers and two ideas of what is staged.
    fireEvent.click(screen.getByRole('button', { name: 'open app again' }));

    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(tab('app')).toHaveAttribute('aria-selected', 'true');
  });

  it('switches between open repositories', () => {
    openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Krakenless' }));
    fireEvent.click(screen.getByRole('button', { name: 'open other' }));

    fireEvent.click(tab('app'));

    expect(tab('app')).toHaveAttribute('aria-selected', 'true');
    expect(tab('other')).toHaveAttribute('aria-selected', 'false');
  });

  it('closes a tab and the repository behind it', async () => {
    const store = openFirst();

    fireEvent.click(screen.getByRole('button', { name: 'Close app' }));

    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(store.getState().repo.state).toBe('idle');
    // The last tab closing lands on the repository list, not on an empty shell.
    expect(screen.getByText('welcome view')).toBeInTheDocument();
    await waitFor(() => expect(stop).toHaveBeenCalled());
  });

  it('keeps every open repository watched, not just the one on screen', async () => {
    openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Krakenless' }));
    fireEvent.click(screen.getByRole('button', { name: 'open other' }));

    // Two repositories open, two watches; leaving a tab must not stop its own.
    await waitFor(() => expect(watchRepository).toHaveBeenCalledTimes(2));
    expect(stop).not.toHaveBeenCalled();
  });

  it('answers the keyboard only in the tab on screen', () => {
    openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Krakenless' }));
    fireEvent.click(screen.getByRole('button', { name: 'open other' }));

    fireEvent.keyDown(window, { key: 'w', ctrlKey: true });

    // One repository closed, not both.
    expect(screen.getAllByRole('tab')).toHaveLength(1);
  });
});
