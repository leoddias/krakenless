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
import { forgetRepo, openRepo } from '../../state/actions';
import { StoreProvider } from '../../state/hooks';
import { createStore, type Store } from '../../state/store';
import type { AppConfig, RecentRepo } from '../../config/schema';
import { defaultConfig } from '../../config/schema';
import { WelcomeView } from './WelcomeView';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('../../state/actions', () => ({
  openRepo: vi.fn(async () => {}),
  forgetRepo: vi.fn(async () => {}),
}));

const { open } = await import('@tauri-apps/plugin-dialog');
const pickFolder = vi.mocked(open);

function configWith(recentRepos: RecentRepo[]): AppConfig {
  return { ...defaultConfig(), recentRepos };
}

function renderWelcome(recentRepos: RecentRepo[] = []): Store {
  const store = createStore();
  store.dispatch({ type: 'config/loaded', config: configWith(recentRepos) });
  render(
    <StoreProvider store={store}>
      <WelcomeView />
    </StoreProvider>,
  );
  return store;
}

/** The button that opens a recent row; its name comes from its visible text. */
function openButton(path: string): HTMLElement {
  const row = screen
    .getAllByRole('listitem')
    .find((item) => within(item).queryByText(path) !== null);
  if (row === undefined) throw new Error(`no recent row for ${path}`);
  // First button in the row is the opener, second is "Forget".
  return within(row).getAllByRole('button')[0] as HTMLElement;
}

const recents: RecentRepo[] = [
  { path: 'C:/code/newest', lastOpened: '2026-08-20T10:00:00.000Z' },
  { path: 'C:/code/older', lastOpened: '2026-08-10T10:00:00.000Z' },
];

beforeEach(() => {
  vi.clearAllMocks();
});

// Vitest runs without globals here, so Testing Library's auto-cleanup is off.
afterEach(() => {
  cleanup();
});

describe('WelcomeView', () => {
  it('shows an empty state when there are no recent repositories', () => {
    renderWelcome();
    expect(
      screen.getByText('No recent repositories yet. Open a folder to get started.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('lists recent repositories in store order, newest first, with name and path', () => {
    // The store hands the list over already ordered (config's withRecentRepo
    // prepends), so the view must not re-sort or reverse it.
    renderWelcome(recents);
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('C:/code/newest');
    expect(rows[1]).toHaveTextContent('C:/code/older');
    expect(screen.getByText('newest')).toBeInTheDocument();
    expect(screen.getByText('C:/code/older')).toBeInTheDocument();
  });

  it('keeps the repository name and recency in the row button name', () => {
    renderWelcome(recents);
    const name = openButton('C:/code/newest').textContent ?? '';
    expect(name).toContain('newest');
    expect(name).toContain('C:/code/newest');
    expect(name).toContain('Opened');
  });

  it('opens a recent repository through the action layer', () => {
    const store = renderWelcome(recents);
    fireEvent.click(openButton('C:/code/older'));
    expect(openRepo).toHaveBeenCalledWith(store, 'C:/code/older');
  });

  it('opens the folder the picker returns', async () => {
    pickFolder.mockResolvedValue('D:/repos/picked');
    const store = renderWelcome();
    fireEvent.click(screen.getByRole('button', { name: 'Open a repository…' }));
    await waitFor(() => {
      expect(openRepo).toHaveBeenCalledWith(store, 'D:/repos/picked');
    });
    expect(pickFolder).toHaveBeenCalledWith({ directory: true, multiple: false });
  });

  it('does nothing when the folder picker is cancelled', async () => {
    pickFolder.mockResolvedValue(null);
    renderWelcome();
    fireEvent.click(screen.getByRole('button', { name: 'Open a repository…' }));
    await waitFor(() => {
      expect(pickFolder).toHaveBeenCalled();
    });
    expect(openRepo).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reports a folder picker that fails instead of failing silently', async () => {
    pickFolder.mockRejectedValue(new Error('dialog plugin unavailable'));
    renderWelcome();
    fireEvent.click(screen.getByRole('button', { name: 'Open a repository…' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The folder picker could not be opened. dialog plugin unavailable',
    );
    expect(openRepo).not.toHaveBeenCalled();
  });

  it('clears a stale picker failure when a recent repository is opened', async () => {
    pickFolder.mockRejectedValue(new Error('dialog plugin unavailable'));
    renderWelcome(recents);
    fireEvent.click(screen.getByRole('button', { name: 'Open a repository…' }));
    await screen.findByRole('alert');

    fireEvent.click(openButton('C:/code/newest'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('forgets a recent repository through the action layer', () => {
    const store = renderWelcome(recents);
    fireEvent.click(screen.getByRole('button', { name: 'Forget C:/code/newest' }));
    expect(forgetRepo).toHaveBeenCalledWith(store, 'C:/code/newest');
  });

  it('keeps focus on screen after forgetting the last recent repository', () => {
    renderWelcome([recents[0] as RecentRepo]);
    fireEvent.click(screen.getByRole('button', { name: 'Forget C:/code/newest' }));
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Open a repository…' }),
    );
  });

  it('shows a loading state while a repository is opening', () => {
    const store = renderWelcome(recents);
    fireEvent.click(openButton('C:/code/newest'));
    act(() => store.dispatch({ type: 'repo/opening' }));

    expect(screen.getByRole('status')).toHaveTextContent('Opening repository…');
    expect(screen.getByRole('button', { name: 'Open a repository…' })).toBeDisabled();
    expect(openButton('C:/code/older')).toBeDisabled();
  });

  it('uses real buttons so Enter and Space activate them', () => {
    renderWelcome(recents);
    for (const button of screen.getAllByRole('button')) {
      expect(button).toBeInstanceOf(HTMLButtonElement);
      expect(button).toHaveAttribute('type', 'button');
    }
  });
});

describe('WelcomeView error wording', () => {
  function renderError(message: string, kind?: string): void {
    const store = renderWelcome(recents);
    act(() => store.dispatch({ type: 'repo/failed', message, kind }));
  }

  it('says git is missing when the binary cannot be found', () => {
    renderError('git was not found on PATH', 'git-missing');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Git is not installed, or it is not on your PATH.');
    expect(alert).toHaveTextContent(
      'Install git, then restart Krakenless so it can find the binary.',
    );
    // Picking another folder cannot fix a missing binary, so it is not offered.
    expect(
      screen.queryByRole('button', { name: 'Choose another folder' }),
    ).not.toBeInTheDocument();
  });

  it('says the folder is not a repository and offers another folder', () => {
    renderError('Not a git repository', 'not-a-repository');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('That folder is not a git repository.');
    expect(alert).toHaveTextContent(
      'Pick a folder that contains a .git directory, or one inside it.',
    );
    expect(
      screen.getByRole('button', { name: 'Choose another folder' }),
    ).toBeInTheDocument();
  });

  it('says the folder could not be read for a bad path', () => {
    renderError('repository path is not a directory', 'bad-repo-path');
    expect(screen.getByRole('alert')).toHaveTextContent('That folder could not be read.');
  });

  it('says git timed out', () => {
    renderError('git rev-parse timed out', 'timeout');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Git took too long to answer and the command was stopped.',
    );
  });

  it('falls back to git own words for an unknown kind', () => {
    renderError('error: object file is empty', 'command-failed');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Git could not open this repository.');
    expect(alert).toHaveTextContent('Git said: error: object file is empty');
  });

  it('retries the picker from the error panel', async () => {
    pickFolder.mockResolvedValue('D:/repos/second-try');
    const store = createStore();
    store.dispatch({ type: 'config/loaded', config: configWith([]) });
    render(
      <StoreProvider store={store}>
        <WelcomeView />
      </StoreProvider>,
    );
    act(() =>
      store.dispatch({
        type: 'repo/failed',
        message: 'Not a git repository',
        kind: 'not-a-repository',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Choose another folder' }));
    await waitFor(() => {
      expect(openRepo).toHaveBeenCalledWith(store, 'D:/repos/second-try');
    });
  });
});
