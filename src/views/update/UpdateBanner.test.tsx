import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const checkForUpdate = vi.fn();
vi.mock('../../update/check', () => ({ checkForUpdate }));

const { UpdateBanner } = await import('./UpdateBanner');

function offer(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'portable',
    version: '0.1.10',
    notes: '',
    apply: vi.fn(() => new Promise<void>(() => {})),
    ...overrides,
  };
}

beforeEach(() => {
  checkForUpdate.mockReset();
});

describe('UpdateBanner', () => {
  it('says nothing while there is no update', async () => {
    checkForUpdate.mockResolvedValue(null);
    render(<UpdateBanner enabled />);
    await waitFor(() => {
      expect(checkForUpdate).toHaveBeenCalled();
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('does not touch the network when the setting is off', () => {
    render(<UpdateBanner enabled={false} />);
    expect(checkForUpdate).not.toHaveBeenCalled();
  });

  it('names the version and warns that a portable update replaces the file', async () => {
    checkForUpdate.mockResolvedValue(offer());
    render(<UpdateBanner enabled />);

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Krakenless 0.1.10 is available. It will replace this file and restart.',
    );
  });

  it('leaves the replacement warning out for an installed build', async () => {
    checkForUpdate.mockResolvedValue(offer({ kind: 'installed' }));
    render(<UpdateBanner enabled />);

    expect(await screen.findByRole('status')).not.toHaveTextContent('replace this file');
  });

  it('downloads nothing until Update is pressed', async () => {
    const update = offer();
    checkForUpdate.mockResolvedValue(update);
    render(<UpdateBanner enabled />);
    await screen.findByRole('status');

    expect(update.apply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(update.apply).toHaveBeenCalledOnce();
  });

  it('reports a failed update instead of leaving the button spinning', async () => {
    const update = offer({ apply: vi.fn().mockRejectedValue(new Error('disk is full')) });
    checkForUpdate.mockResolvedValue(update);
    render(<UpdateBanner enabled />);
    await screen.findByRole('status');

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not update: disk is full',
    );
    expect(screen.getByRole('button', { name: 'Update' })).toBeEnabled();
  });

  it('says so when the update returns without restarting the app', async () => {
    const update = offer({ apply: vi.fn().mockResolvedValue(undefined) });
    checkForUpdate.mockResolvedValue(update);
    render(<UpdateBanner enabled />);
    await screen.findByRole('status');

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('without restarting');
  });

  it('goes away for this launch when Later is pressed', async () => {
    checkForUpdate.mockResolvedValue(offer());
    render(<UpdateBanner enabled />);
    await screen.findByRole('status');

    fireEvent.click(screen.getByRole('button', { name: 'Later' }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows the release notes when the manifest carried any', async () => {
    checkForUpdate.mockResolvedValue(offer({ notes: 'Fixes the diff panel.' }));
    render(<UpdateBanner enabled />);

    expect(await screen.findByText('Fixes the diff panel.')).toBeInTheDocument();
  });
});
