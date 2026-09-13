import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DISMISS_AFTER_MS } from './autoDismiss';
import { NoticeBar } from './NoticeBar';
import { StoreProvider } from '../../state/hooks';
import { createStore, type NoticeInput, type Store } from '../../state/store';

function renderBar(notice: NoticeInput | null): Store {
  const store = createStore();
  if (notice !== null) store.dispatch({ type: 'notice', notice });
  render(
    <StoreProvider store={store}>
      <NoticeBar />
    </StoreProvider>,
  );
  return store;
}

describe('NoticeBar', () => {
  it('renders nothing when there is no notice', () => {
    renderBar(null);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows an informational message', () => {
    renderBar({ tone: 'info', message: 'Discarded changes to 2 file(s).' });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Discarded changes to 2 file(s).',
    );
  });

  it('announces errors assertively', () => {
    renderBar({ tone: 'error', message: 'Authentication failed' });
    expect(screen.getByRole('alert')).toHaveTextContent('Authentication failed');
  });

  it('shows every undo command verbatim', () => {
    // The command carries a stash oid the user cannot reconstruct; truncating
    // or paraphrasing it would strand the discarded work.
    renderBar({
      tone: 'info',
      message: 'Discarded changes to 2 file(s).',
      undoHint:
        'git restore --source=aaa111 --worktree -- "a.txt"\ngit restore --source=bbb222 --worktree -- "b.txt"',
    });

    expect(
      screen.getByText('git restore --source=aaa111 --worktree -- "a.txt"'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('git restore --source=bbb222 --worktree -- "b.txt"'),
    ).toBeInTheDocument();
  });

  it('has no undo section when there is nothing to undo', () => {
    renderBar({ tone: 'warning', message: 'Nothing to discard.' });
    expect(screen.queryByText('Run this to undo:')).not.toBeInTheDocument();
  });

  it('stays until dismissed', () => {
    const store = renderBar({ tone: 'info', message: 'Done.' });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(store.getState().notice).toBeNull();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

afterEach(cleanup);

describe('NoticeBar dismissing itself', () => {
  it('clears the notice once the delay has passed', () => {
    vi.useFakeTimers();
    const store = renderBar({ tone: 'info', message: 'Fetched from origin.' });
    expect(screen.getByRole('status')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(DISMISS_AFTER_MS);
    });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(store.getState().notice).toBeNull();
    vi.useRealTimers();
  });

  it('gives a notice that replaces another a full ten seconds of its own', () => {
    // The id is the key, so a second notice is a second clock. Keying on the
    // message would let two identical failures share one, and the second would
    // disappear while the user was still reading it.
    vi.useFakeTimers();
    const store = renderBar({ tone: 'error', message: 'First.' });

    act(() => {
      vi.advanceTimersByTime(DISMISS_AFTER_MS - 500);
      store.dispatch({ type: 'notice', notice: { tone: 'error', message: 'Second.' } });
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Second.');

    act(() => {
      vi.advanceTimersByTime(DISMISS_AFTER_MS);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('still goes when the button is pressed before the timer', () => {
    vi.useFakeTimers();
    const store = renderBar({ tone: 'info', message: 'Fetched from origin.' });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(store.getState().notice).toBeNull();
    vi.useRealTimers();
  });
});
