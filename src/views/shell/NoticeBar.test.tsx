import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
