import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Operation } from '../../git/operation';
import type { RepoStatus, StatusEntry } from '../../git/types';
import {
  abortStoppedOperation,
  continueStoppedOperation,
  skipStoppedCommit,
} from '../../state/actions';
import { StoreProvider } from '../../state/hooks';
import { createStore, type Store } from '../../state/store';
import { OperationPanel } from './OperationPanel';

vi.mock('../../state/actions', () => ({
  abortStoppedOperation: vi.fn(),
  continueStoppedOperation: vi.fn(),
  skipStoppedCommit: vi.fn(),
}));

const abortMock = vi.mocked(abortStoppedOperation);
const continueMock = vi.mocked(continueStoppedOperation);
const skipMock = vi.mocked(skipStoppedCommit);

const OID = 'a'.repeat(40);

function operation(overrides: Partial<Operation> = {}): Operation {
  return {
    kind: 'rebase',
    commit: { oid: OID, subject: 'feat(server): send bestiary kill progress' },
    step: 3,
    steps: 43,
    branch: 'feat/x',
    ...overrides,
  };
}

function conflicted(path: string): StatusEntry {
  return {
    path,
    index: 'unmerged',
    worktree: 'unmerged',
    conflicted: true,
    conflictKind: 'UU',
  };
}

function status(entries: StatusEntry[] = []): RepoStatus {
  return {
    branch: null,
    head: OID,
    detached: true,
    entries,
    hasConflicts: entries.length > 0,
  };
}

function renderPanel(
  current: Operation = operation(),
  entries: StatusEntry[] = [],
): Store {
  const store = createStore();
  store.dispatch({
    type: 'repo/opened',
    repo: { root: 'C:/repo', gitDir: 'C:/repo/.git', bare: false, empty: false },
  });
  store.dispatch({ type: 'operation/read', operation: current });
  store.dispatch({ type: 'status/loaded', status: status(entries) });
  render(
    <StoreProvider store={store}>
      <OperationPanel />
    </StoreProvider>,
  );
  return store;
}

beforeEach(() => {
  abortMock.mockReset().mockResolvedValue(true);
  continueMock.mockReset().mockResolvedValue(true);
  skipMock.mockReset().mockResolvedValue(true);
});

afterEach(cleanup);

describe('what the panel says', () => {
  it('shows nothing at all when nothing is in progress', () => {
    renderPanel(
      operation({ kind: null, commit: null, step: null, steps: null, branch: null }),
    );
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('says where the rebase is, in git\u2019s own counting', () => {
    renderPanel();
    expect(screen.getByText('Rebasing commit 3 of 43 of feat/x.')).toBeInTheDocument();
    expect(
      screen.getByText('feat(server): send bestiary kill progress'),
    ).toBeInTheDocument();
  });

  it('still says a rebase is running when git recorded no counters', () => {
    renderPanel(operation({ step: null, steps: null }));
    expect(screen.getByText(/Rebasing a commit of feat\/x\./)).toBeInTheDocument();
  });

  it('names the operation on every control, never "merge" by default', () => {
    // The bug this panel exists for: a rebase offered `git merge --abort`,
    // which fails with "MERGE_HEAD missing" and leaves the user stuck.
    renderPanel();
    expect(screen.getByRole('button', { name: 'Continue rebase' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Abort rebase…' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /merge/i })).toBeNull();
  });

  it('offers a cherry-pick and a revert their own verbs', () => {
    renderPanel(operation({ kind: 'cherry-pick' }));
    expect(
      screen.getByRole('button', { name: 'Continue cherry-pick' }),
    ).toBeInTheDocument();
    cleanup();

    renderPanel(operation({ kind: 'revert' }));
    expect(screen.getByRole('button', { name: 'Continue revert' })).toBeInTheDocument();
  });

  it('does not offer to continue or skip a merge, which has neither', () => {
    // `git merge --continue` is not "resume": a stopped merge ends by
    // committing the resolution, which is what the commit box is for.
    renderPanel(operation({ kind: 'merge', step: null, steps: null, branch: null }));
    expect(screen.queryByRole('button', { name: /Continue/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Skip/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Abort merge…' })).toBeInTheDocument();
  });
});

describe('continuing', () => {
  it('continues with what is staged, passing the sentence as the reason', () => {
    const store = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Continue rebase' }));

    expect(continueMock).toHaveBeenCalledTimes(1);
    expect(continueMock.mock.calls[0]?.[0]).toBe(store);
    expect(continueMock.mock.calls[0]?.[1]).toBe('rebase');
    expect(continueMock.mock.calls[0]?.[2]).toContain('Continue the rebase');
  });

  it('refuses while a file is still conflicted, and says how many', () => {
    // Git refuses too, loudly; saying it first turns a failed command into a
    // disabled button with a reason next to it.
    renderPanel(operation(), [conflicted('a.ts'), conflicted('b.ts')]);

    expect(screen.getByRole('button', { name: 'Continue rebase' })).toBeDisabled();
    expect(screen.getByText(/2 files are still conflicted/)).toBeInTheDocument();
    expect(continueMock).not.toHaveBeenCalled();
  });

  it('lets the rebase continue once nothing is unmerged', () => {
    renderPanel(operation(), []);
    expect(screen.getByRole('button', { name: 'Continue rebase' })).toBeEnabled();
  });
});

describe('skipping and aborting', () => {
  it('never aborts without a second, explicit confirmation', () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Abort rebase…' }));
    expect(abortMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Abort rebase' }));
    expect(abortMock).toHaveBeenCalledTimes(1);
  });

  it('passes the text the user agreed to as the confirmation', () => {
    const store = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Abort rebase…' }));
    const question = screen.getByText(/Abort the rebase/).textContent ?? '';
    fireEvent.click(screen.getByRole('button', { name: 'Abort rebase' }));

    expect(abortMock).toHaveBeenCalledWith(store, 'rebase', question);
    expect(question).toContain('discarded');
  });

  it('lets the user back out of aborting', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Abort rebase…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(abortMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Abort rebase…' })).toBeInTheDocument();
  });

  it('asks before skipping, and says the commit is left out', () => {
    const store = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Skip commit…' }));
    expect(skipMock).not.toHaveBeenCalled();

    // The button says the same words, so the question is matched by its start.
    const question = screen.getByText(/^Skip this commit and carry on/).textContent ?? '';
    fireEvent.click(screen.getByRole('button', { name: 'Skip this commit' }));

    expect(skipMock).toHaveBeenCalledWith(store, 'rebase', question);
    expect(question).toContain('left out of the result');
  });

  it('aborts the operation git is actually in', () => {
    renderPanel(operation({ kind: 'merge', step: null, steps: null, branch: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Abort merge…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abort merge' }));

    expect(abortMock.mock.calls[0]?.[1]).toBe('merge');
  });
});

describe('while another command runs', () => {
  it('disables every way out', () => {
    const store = renderPanel();
    act(() => store.dispatch({ type: 'busy', busy: true }));

    expect(screen.getByRole('button', { name: 'Continue rebase' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Skip commit…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Abort rebase…' })).toBeDisabled();
  });
});
