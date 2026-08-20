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
    fireEvent.click(await screen.findByRole('button', { name: 'Open config folder' }));
    expect(revealFolder).toHaveBeenCalledWith('C:/Users/x/AppData/Roaming/krakenless');
  });

  it('reports a file manager that refused to open', async () => {
    revealFolder.mockRejectedValue(new Error('no file manager'));
    renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Open config folder' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no file manager');
  });

  it('says what the app is and how it is funded', () => {
    renderSettings();
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
    expect(screen.getByRole('checkbox', { name: /author pictures/i })).not.toBeChecked();
  });

  it('says plainly what is sent and to whom', () => {
    // The whole pitch is privacy: the copy has to name the host and the thing
    // it receives, not describe the feature and leave that out.
    renderSettings();
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
    fireEvent.click(screen.getByRole('checkbox', { name: /author pictures/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(1));
    expect(saveConfig.mock.calls[0]?.[0]).toMatchObject({ remoteAvatars: true });
    expect(store.getState().config.remoteAvatars).toBe(true);
  });

  it('changes what About claims once pictures are on', () => {
    renderSettings();
    expect(screen.getByLabelText('About')).not.toHaveTextContent('Gravatar');

    fireEvent.click(screen.getByRole('checkbox', { name: /author pictures/i }));
    expect(screen.getByLabelText('About')).toHaveTextContent(
      'plus Gravatar and GitHub for the author pictures you turned on above',
    );
  });

  it('drops the saved marker as soon as a field changes again', async () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');

    fireEvent.change(screen.getByLabelText(/Editor command/), { target: { value: 'x' } });
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument();
  });
});
