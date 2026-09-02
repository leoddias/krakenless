import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stop = vi.fn();
const startUpdateChecks = vi.fn();
vi.mock('../../update/schedule', () => ({ startUpdateChecks }));

const { UpdateDialog } = await import('./UpdateDialog');

type Found = (update: Record<string, unknown>) => void;

/** The callback the component handed to the schedule. */
let report: Found;

function offer(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'portable',
    version: '0.1.11',
    notes: '',
    apply: vi.fn(() => new Promise<void>(() => {})),
    ...overrides,
  };
}

beforeEach(() => {
  stop.mockReset();
  startUpdateChecks.mockReset();
  startUpdateChecks.mockImplementation((onFound: Found) => {
    report = onFound;
    return { stop };
  });
});

/** Renders, then delivers one update through the schedule callback. */
function renderWith(update: Record<string, unknown> | null) {
  const view = render(<UpdateDialog enabled />);
  if (update !== null) act(() => report(update));
  return view;
}

describe('UpdateDialog', () => {
  it('shows nothing, and starts a schedule, when there is no update yet', () => {
    render(<UpdateDialog enabled />);
    expect(startUpdateChecks).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('starts no schedule at all when the setting is off', () => {
    render(<UpdateDialog enabled={false} />);
    expect(startUpdateChecks).not.toHaveBeenCalled();
  });

  it('stops the schedule when it goes away', () => {
    const { unmount } = render(<UpdateDialog enabled />);
    unmount();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('opens a modal dialog naming the version', () => {
    renderWith(offer());
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveTextContent('Krakenless 0.1.11 is available');
  });

  it('says a portable update replaces the program file', () => {
    renderWith(offer());
    expect(screen.getByRole('dialog')).toHaveTextContent('replaces this program file');
  });

  it('says an installed update runs the installer', () => {
    renderWith(offer({ kind: 'installed' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('runs the installer');
    expect(dialog).not.toHaveTextContent('replaces this program file');
  });

  it('shows release notes with the Markdown markers taken out', () => {
    renderWith(offer({ notes: '**Pre-alpha.** Not dogfooded yet.' }));
    expect(screen.getByRole('group', { name: 'Release notes' })).toHaveTextContent(
      'Pre-alpha. Not dogfooded yet.',
    );
  });

  it('shows no notes box when the release carried none', () => {
    renderWith(offer({ notes: '' }));
    expect(
      screen.queryByRole('group', { name: 'Release notes' }),
    ).not.toBeInTheDocument();
  });

  it('downloads nothing until Update is pressed', () => {
    const update = offer();
    renderWith(update);

    expect(update.apply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Update and restart' }));
    expect(update.apply).toHaveBeenCalledOnce();
  });

  it('reports a failed update in the dialog and re-enables the button', async () => {
    const update = offer({ apply: vi.fn().mockRejectedValue(new Error('disk is full')) });
    renderWith(update);

    fireEvent.click(screen.getByRole('button', { name: 'Update and restart' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not update: disk is full',
    );
    expect(screen.getByRole('button', { name: 'Update and restart' })).toBeEnabled();
  });

  it('says so when the update returns without restarting the app', async () => {
    const update = offer({ apply: vi.fn().mockResolvedValue(undefined) });
    renderWith(update);

    fireEvent.click(screen.getByRole('button', { name: 'Update and restart' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('without restarting');
  });

  it('closes on Later', () => {
    renderWith(offer());
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Escape', () => {
    renderWith(offer());
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not ask again about a version already declined', () => {
    renderWith(offer());
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));

    // The hourly check finds the same version an hour later.
    act(() => report(offer()));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does ask again when a newer version appears after one was declined', () => {
    renderWith(offer({ version: '0.1.11' }));
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));

    act(() => report(offer({ version: '0.1.12' })));

    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Krakenless 0.1.12 is available',
    );
  });

  it('does not swap the offer under a user who is mid-install', () => {
    const update = offer();
    renderWith(update);
    fireEvent.click(screen.getByRole('button', { name: 'Update and restart' }));

    act(() => report(offer({ version: '0.1.12' })));

    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Krakenless 0.1.11 is available',
    );
  });

  it('cannot be dismissed while the update is running', () => {
    renderWith(offer());
    fireEvent.click(screen.getByRole('button', { name: 'Update and restart' }));

    expect(screen.getByRole('button', { name: 'Later' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('takes focus, so the keyboard is inside the question', () => {
    renderWith(offer());
    expect(screen.getByRole('dialog')).toHaveFocus();
  });
});
