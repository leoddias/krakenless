/**
 * That the background fetch is actually *started* by the running app.
 *
 * `autoFetch.test.ts` proves the schedule fetches on its interval; nothing
 * proved anybody ever asked it to. A schedule that is never started and one
 * that fails on every tick look identical from the outside — no panel moves,
 * no error appears — which is exactly how "it never fetches" gets reported
 * against code whose own unit tests are green.
 */

import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { StoreProvider } from './state/hooks';
import { createStore, type Store } from './state/store';
import { defaultConfig } from './config/schema';
import type { RepoInfo } from './git/types';

const loadConfig = vi.hoisted(() => vi.fn());
const saveConfig = vi.hoisted(() => vi.fn());
const watchRepository = vi.hoisted(() => vi.fn());
const startAutoFetch = vi.hoisted(() => vi.fn());
const stopAutoFetch = vi.hoisted(() => vi.fn());

vi.mock('./config/store', () => ({ loadConfig, saveConfig, configFolder: vi.fn() }));
vi.mock('./state/watch', () => ({ watchRepository }));
vi.mock('./state/autoFetch', () => ({ startAutoFetch }));
vi.mock('./views/welcome', () => ({ WelcomeView: () => <div>welcome view</div> }));
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
vi.mock('./views/settings', () => ({ SettingsView: () => <div>settings view</div> }));

const REPO: RepoInfo = {
  root: 'C:/repos/app',
  gitDir: 'C:/repos/app/.git',
  bare: false,
  empty: false,
};

function openStore(): Store {
  const store = createStore();
  store.dispatch({ type: 'repo/opened', repo: REPO });
  return store;
}

function renderApp(store: Store) {
  return render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
}

describe('background fetch wiring', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    loadConfig.mockResolvedValue(defaultConfig());
    saveConfig.mockResolvedValue(undefined);
    watchRepository.mockResolvedValue({ stop: vi.fn() });
    startAutoFetch.mockReturnValue({ stop: stopAutoFetch });
    stopAutoFetch.mockResolvedValue(undefined);
  });

  it('starts a schedule for the open repository at the configured interval', () => {
    const store = openStore();
    renderApp(store);

    expect(startAutoFetch).toHaveBeenCalledWith(
      store,
      REPO.root,
      defaultConfig().autoFetchMinutes,
    );
  });

  it('starts nothing when no repository is open', () => {
    renderApp(createStore());
    expect(startAutoFetch).not.toHaveBeenCalled();
  });

  it('stops the schedule when the repository closes', () => {
    const store = openStore();
    const { unmount } = renderApp(store);

    unmount();
    expect(stopAutoFetch).toHaveBeenCalled();
  });
});
