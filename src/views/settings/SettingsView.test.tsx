import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../config/schema';
import { SettingsView } from './SettingsView';
import { StoreProvider } from '../../state/hooks';
import { createStore, type Store } from '../../state/store';

const saveConfig = vi.hoisted(() => vi.fn());
const configFolder = vi.hoisted(() => vi.fn());
const revealFolder = vi.hoisted(() => vi.fn());
vi.mock('../../config/store', () => ({ saveConfig, configFolder, loadConfig: vi.fn() }));
vi.mock('../../config/launch', () => ({ revealFolder }));

function renderSettings(store: Store = createStore()): {
  store: Store;
  onClose: () => void;
} {
  const onClose = vi.fn();
  render(
    <StoreProvider store={store}>
      <SettingsView onClose={onClose} />
    </StoreProvider>,
  );
  return { store, onClose };
}

/**
 * Opens one section of the settings.
 *
 * The screen shows a section at a time now, so a test that reaches for a field
 * has to say which page it is on — which doubles as the assertion that the rail
 * navigates at all.
 */
function goTo(section: string): void {
  fireEvent.click(screen.getByRole('button', { name: section }));
}

describe('SettingsView', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    saveConfig.mockResolvedValue(undefined);
    configFolder.mockResolvedValue('C:/Users/x/AppData/Roaming/krakenless');
    revealFolder.mockResolvedValue(undefined);
  });

  it('shows the current settings', () => {
    const store = createStore();
    store.dispatch({
      type: 'config/loaded',
      config: {
        ...defaultConfig(),
        editorCommand: 'code -g',
        mergetool: 'vscode',
        theme: 'light',
      },
    });
    renderSettings(store);

    expect(screen.getByLabelText(/Editor command/)).toHaveValue('code -g');
    expect(screen.getByLabelText(/Merge tool/)).toHaveValue('vscode');

    goTo('Appearance');
    expect(screen.getByRole('radio', { name: 'light' })).toBeChecked();
  });

  it('saves an edited field to disk and to the store', async () => {
    const { store } = renderSettings();
    fireEvent.change(screen.getByLabelText(/Editor command/), {
      target: { value: 'subl' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(1));
    expect(saveConfig.mock.calls[0]?.[0]).toMatchObject({ editorCommand: 'subl' });
    expect(store.getState().config.editorCommand).toBe('subl');
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('reports a failed save instead of claiming success', async () => {
    // Otherwise the next session starts with the old settings and no clue why.
    saveConfig.mockRejectedValue(new Error('disk full'));
    const { store } = renderSettings();
    fireEvent.change(screen.getByLabelText(/Merge tool/), { target: { value: 'meld' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('disk full');
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument();
    expect(store.getState().config.mergetool).toBe('');
  });

  it('shows where the settings file lives, for backups', async () => {
    renderSettings();
    goTo('About');
    expect(
      await screen.findByText('C:/Users/x/AppData/Roaming/krakenless'),
    ).toBeInTheDocument();
  });

  it('still works when the folder path cannot be read', async () => {
    configFolder.mockRejectedValue(new Error('nope'));
    renderSettings();
    await waitFor(() => expect(configFolder).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('opens the config folder in the file manager', async () => {
    renderSettings();
    goTo('About');
    fireEvent.click(await screen.findByRole('button', { name: 'Open config folder' }));
    expect(revealFolder).toHaveBeenCalledWith('C:/Users/x/AppData/Roaming/krakenless');
  });

  it('reports a file manager that refused to open', async () => {
    revealFolder.mockRejectedValue(new Error('no file manager'));
    renderSettings();
    goTo('About');
    fireEvent.click(await screen.findByRole('button', { name: 'Open config folder' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no file manager');
  });

  it('says what the app is and how it is funded', () => {
    renderSettings();
    goTo('About');
    const about = screen.getByLabelText('About');
    expect(about).toHaveTextContent('no telemetry');
    expect(about).toHaveTextContent('AGPL-3.0');
  });

  it('closes when asked', () => {
    const { onClose } = renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('offers author pictures switched off', () => {
    renderSettings();
    goTo('Privacy & updates');
    expect(screen.getByRole('checkbox', { name: /author pictures/i })).not.toBeChecked();
  });

  it('says plainly what is sent and to whom', () => {
    // The whole pitch is privacy: the copy has to name the host and the thing
    // it receives, not describe the feature and leave that out.
    renderSettings();
    goTo('Privacy & updates');
    const field = screen
      .getByRole('checkbox', { name: /author pictures/i })
      .closest('label');
    expect(field).toHaveTextContent('www.gravatar.com');
    expect(field).toHaveTextContent('hash of their email address and your IP address');
    expect(field).toHaveTextContent('avatars.githubusercontent.com');
    expect(field).toHaveTextContent('thirty days');
  });

  it('saves the choice to fetch pictures', async () => {
    const { store } = renderSettings();
    goTo('Privacy & updates');
    fireEvent.click(screen.getByRole('checkbox', { name: /author pictures/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(1));
    expect(saveConfig.mock.calls[0]?.[0]).toMatchObject({ remoteAvatars: true });
    expect(store.getState().config.remoteAvatars).toBe(true);
  });

  it('offers the background fetch schedule, five minutes by default', () => {
    renderSettings();
    const field = screen.getByLabelText(/Fetch in the background/);
    expect(field).toHaveValue('5');
    expect(screen.getByRole('option', { name: 'Off' })).toBeInTheDocument();
  });

  it('saves a new fetch schedule', async () => {
    const { store } = renderSettings();
    fireEvent.change(screen.getByLabelText(/Fetch in the background/), {
      target: { value: '15' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(1));
    expect(saveConfig.mock.calls[0]?.[0]).toMatchObject({ autoFetchMinutes: 15 });
    expect(store.getState().config.autoFetchMinutes).toBe(15);
  });

  it('can turn the background fetch off entirely', async () => {
    const { store } = renderSettings();
    fireEvent.change(screen.getByLabelText(/Fetch in the background/), {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(1));
    expect(store.getState().config.autoFetchMinutes).toBe(0);
  });

  it('says what the background fetch does and does not touch', () => {
    renderSettings();
    const field = screen.getByLabelText(/Fetch in the background/).closest('label');
    expect(field).toHaveTextContent('git fetch --prune');
    expect(field).toHaveTextContent('nothing is ever merged into them');
  });

  it('changes what About claims once pictures are on', () => {
    renderSettings();
    goTo('About');
    expect(screen.getByLabelText('About')).not.toHaveTextContent('Gravatar');

    goTo('Privacy & updates');
    fireEvent.click(screen.getByRole('checkbox', { name: /author pictures/i }));

    // The draft is one answer behind every section, so About describes the
    // switch that was just flipped on another page.
    goTo('About');
    expect(screen.getByLabelText('About')).toHaveTextContent(
      'plus Gravatar and GitHub for the author pictures you turned on',
    );
  });

  it('keeps one unsaved draft across the sections', async () => {
    const { store } = renderSettings();
    fireEvent.change(screen.getByLabelText(/Editor command/), {
      target: { value: 'subl' },
    });

    goTo('Appearance');
    fireEvent.click(screen.getByRole('radio', { name: 'light' }));

    // One Save, wherever it is pressed: two sections' worth of changes land in
    // the file together, and neither is quietly dropped by leaving its page.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(1));
    expect(saveConfig.mock.calls[0]?.[0]).toMatchObject({
      editorCommand: 'subl',
      theme: 'light',
    });
    expect(store.getState().config.theme).toBe('light');
  });

  it('offers a commit count for the graph, and saves it', async () => {
    const { store } = renderSettings();
    const field = screen.getByLabelText(/Commits in the graph/);
    expect(field).toHaveValue('200');

    fireEvent.change(field, { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(1));
    expect(saveConfig.mock.calls[0]?.[0]).toMatchObject({ historyLimit: 2000 });
    expect(store.getState().config.historyLimit).toBe(2000);
  });

  it('says what a bigger graph costs, rather than only offering it', () => {
    renderSettings();
    const field = screen.getByLabelText(/Commits in the graph/).closest('label');
    expect(field).toHaveTextContent('row with a graph cell and an author badge');
  });

  it('drops the saved marker as soon as a field changes again', async () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');

    fireEvent.change(screen.getByLabelText(/Editor command/), { target: { value: 'x' } });
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument();
  });
});
