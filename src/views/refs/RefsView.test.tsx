import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Branch, StashEntry } from '../../git/types';
import {
  createAndSwitch,
  refreshBranches,
  refreshStashes,
  removeBranch,
  removeStash,
  restoreStash,
  switchTo,
} from '../../state/actions';
import { StoreProvider } from '../../state/hooks';
import { createStore, type Store } from '../../state/store';
import { RefsView } from './RefsView';

vi.mock('../../state/actions', () => ({
  refreshBranches: vi.fn(),
  refreshStashes: vi.fn(),
  switchTo: vi.fn(),
  createAndSwitch: vi.fn(),
  removeBranch: vi.fn(),
  restoreStash: vi.fn(),
  removeStash: vi.fn(),
}));

const refreshBranchesMock = vi.mocked(refreshBranches);
const refreshStashesMock = vi.mocked(refreshStashes);
const switchToMock = vi.mocked(switchTo);
const createMock = vi.mocked(createAndSwitch);
const removeBranchMock = vi.mocked(removeBranch);
const restoreStashMock = vi.mocked(restoreStash);
const removeStashMock = vi.mocked(removeStash);

function branch(overrides: Partial<Branch> & { name: string }): Branch {
  return {
    current: false,
    oid: 'a'.repeat(40),
    ahead: 0,
    behind: 0,
    remote: false,
    ...overrides,
  };
}

function stash(
  overrides: Partial<StashEntry> & { ref: string; oid: string },
): StashEntry {
  return {
    index: 0,
    message: 'WIP on main: work',
    date: new Date().toISOString(),
    ...overrides,
  };
}

const BRANCHES: Branch[] = [
  branch({ name: 'main', current: true, upstream: 'origin/main', ahead: 2, behind: 1 }),
  branch({ name: 'feature/x' }),
  branch({ name: 'origin/main', remote: true }),
];

const STASHES: StashEntry[] = [
  stash({
    ref: 'stash@{0}',
    oid: 'b'.repeat(40),
    index: 0,
    message: 'WIP on main: parser',
    branch: 'main',
    date: '2026-08-19T10:00:00Z',
  }),
  stash({
    ref: 'stash@{1}',
    oid: 'c'.repeat(40),
    index: 1,
    message: 'WIP on feature/x: layout',
    branch: 'feature/x',
    date: '2026-08-10T10:00:00Z',
  }),
];

function openRepo(store: Store): void {
  store.dispatch({
    type: 'repo/opened',
    repo: { root: '/repo', gitDir: '/repo/.git', bare: false, empty: false },
  });
}

function renderRefs(prepare: (store: Store) => void = () => {}): Store {
  const store = createStore();
  prepare(store);
  render(
    <StoreProvider store={store}>
      <RefsView />
    </StoreProvider>,
  );
  return store;
}

/** Repository open with both lists loaded — the ordinary case. */
function renderLoaded(
  branches: Branch[] = BRANCHES,
  stashes: StashEntry[] = STASHES,
): Store {
  return renderRefs((store) => {
    // `repo/opened` resets derived state, so it has to come first.
    openRepo(store);
    store.dispatch({ type: 'branches/loaded', branches });
    store.dispatch({ type: 'stashes/loaded', stashes });
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
  });
}

function region(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

function dialog(): HTMLElement {
  return screen.getByRole('alertdialog');
}

function forceButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Delete anyway and drop those commits' });
}

/** Ticks the "I understand" box that arms the forcing button. */
async function arm(): Promise<void> {
  await click(
    within(dialog()).getByRole('checkbox', {
      name: 'I understand those commits will be lost',
    }),
  );
}

beforeEach(() => {
  refreshBranchesMock.mockReset().mockResolvedValue(undefined);
  refreshStashesMock.mockReset().mockResolvedValue(undefined);
  switchToMock.mockReset().mockResolvedValue(true);
  createMock.mockReset().mockResolvedValue(true);
  removeBranchMock.mockReset().mockResolvedValue({ deleted: true });
  restoreStashMock.mockReset().mockResolvedValue(true);
  removeStashMock.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  // Testing Library only auto-cleans with `globals: true`, which this project
  // does not use.
  cleanup();
});

describe('loading on mount', () => {
  it('loads both lists once a repository is open', () => {
    const store = createStore();
    openRepo(store);
    render(
      <StoreProvider store={store}>
        <RefsView />
      </StoreProvider>,
    );
    expect(refreshBranchesMock).toHaveBeenCalledWith(store);
    expect(refreshStashesMock).toHaveBeenCalledWith(store);
  });

  it('asks git for nothing while no repository is open', () => {
    renderRefs();
    expect(refreshBranchesMock).not.toHaveBeenCalled();
    expect(refreshStashesMock).not.toHaveBeenCalled();
  });
});

describe('panel states', () => {
  it('invites the user to open a repository while idle', () => {
    renderRefs();
    expect(
      screen.getByText('Open a repository to see its branches.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Open a repository to see its stashes.')).toBeInTheDocument();
  });

  it('announces loading for both lists', () => {
    renderRefs((store) => {
      openRepo(store);
      store.dispatch({ type: 'branches/loading' });
      store.dispatch({ type: 'stashes/loading' });
    });
    const live = screen.getAllByRole('status').map((node) => node.textContent);
    expect(live.some((text) => text?.includes('Loading branches…'))).toBe(true);
    expect(live.some((text) => text?.includes('Loading stashes…'))).toBe(true);
  });

  it('shows the branch error and its kind', () => {
    renderRefs((store) => {
      openRepo(store);
      store.dispatch({
        type: 'branches/failed',
        message: 'fatal: not a git repository',
        kind: 'not-a-repository',
      });
    });
    expect(screen.getByText('Could not read the branches')).toBeInTheDocument();
    expect(
      screen.getByText(/fatal: not a git repository \(not-a-repository\)/),
    ).toBeInTheDocument();
  });

  it('shows the stash error and its kind', () => {
    renderRefs((store) => {
      openRepo(store);
      store.dispatch({
        type: 'stashes/failed',
        message: 'could not read the stash list',
        kind: 'parse-failed',
      });
    });
    expect(screen.getByText('Could not read the stashes')).toBeInTheDocument();
    expect(
      screen.getByText(/could not read the stash list \(parse-failed\)/),
    ).toBeInTheDocument();
  });

  it('says both lists are empty rather than showing nothing', () => {
    renderLoaded([], []);
    expect(screen.getByText('No local branches yet.')).toBeInTheDocument();
    expect(screen.getByText('No remote-tracking branches.')).toBeInTheDocument();
    expect(screen.getByText('No stashes.')).toBeInTheDocument();
  });
});

describe('branch list', () => {
  it('separates local from remote branches', () => {
    renderLoaded();
    const local = within(region('Local branches'));
    expect(local.getByRole('button', { name: /feature\/x/ })).toBeInTheDocument();
    expect(local.queryByText('origin/main')).not.toBeInTheDocument();
    expect(
      within(region('Remote branches')).getByText('origin/main'),
    ).toBeInTheDocument();
  });

  it('marks the current branch and does not offer to switch to it', async () => {
    renderLoaded();
    const current = screen.getByRole('button', { name: /main\s*\(current branch\)/ });
    expect(current).toHaveAttribute('aria-current', 'true');
    expect(current).toHaveAttribute('aria-disabled', 'true');
    await click(current);
    expect(switchToMock).not.toHaveBeenCalled();
  });

  it('shows ahead and behind counts per branch', () => {
    renderLoaded();
    const row = screen.getByRole('button', { name: /main\s*\(current branch\)/ })
      .parentElement as HTMLElement;
    expect(within(row).getByText(/↑2/)).toBeInTheDocument();
    expect(within(row).getByText(/↓1/)).toBeInTheDocument();
    expect(within(row).getByTitle('Tracks origin/main, 2 ahead, 1 behind')).toBeTruthy();
  });

  it('switches on click', async () => {
    const store = renderLoaded();
    await click(screen.getByRole('button', { name: /feature\/x/ }));
    expect(switchToMock).toHaveBeenCalledWith(store, 'feature/x');
  });

  it('never lets a refused switch look like a switch', async () => {
    const store = renderLoaded();
    switchToMock.mockImplementation(async () => {
      store.dispatch({
        type: 'notice',
        notice: {
          tone: 'error',
          message: 'error: Your local changes to a.ts would be overwritten by checkout',
        },
      });
      return false;
    });
    await click(screen.getByRole('button', { name: /feature\/x/ }));

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Could not switch to "feature/x"');
    expect(alert).toHaveTextContent('You are still where you were.');
    expect(alert).toHaveTextContent('would be overwritten by checkout');
  });

  it('says nothing extra when the switch worked', async () => {
    renderLoaded();
    await click(screen.getByRole('button', { name: /feature\/x/ }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reaches the branch with the keyboard', () => {
    renderLoaded();
    const target = screen.getByRole('button', { name: /feature\/x/ });
    act(() => target.focus());
    expect(document.activeElement).toBe(target);
    // jsdom does not synthesise the native Enter/Space activation of a button,
    // so the assertion is on the thing that guarantees it: the switch is a real
    // <button> with the button role, not a click-only div.
    expect(target.tagName).toBe('BUTTON');
    expect(target).not.toHaveAttribute('tabindex', '-1');
  });

  it('checks a remote branch out as a local one instead of switching to it', async () => {
    const store = renderLoaded();
    await click(screen.getByRole('button', { name: 'Check out as main' }));
    expect(switchToMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledWith(store, 'main', 'origin/main');
  });

  it('says so when checking a remote branch out did not happen', async () => {
    const store = renderLoaded();
    createMock.mockImplementation(async () => {
      store.dispatch({
        type: 'notice',
        notice: { tone: 'error', message: "fatal: a branch named 'main' already exists" },
      });
      return false;
    });
    await click(screen.getByRole('button', { name: 'Check out as main' }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      'Local branch "main" was not created from origin/main.',
    );
    expect(alert).toHaveTextContent("fatal: a branch named 'main' already exists");
  });

  it('disables every action while a git command is in flight', () => {
    renderRefs((store) => {
      openRepo(store);
      store.dispatch({ type: 'branches/loaded', branches: BRANCHES });
      store.dispatch({ type: 'stashes/loaded', stashes: STASHES });
      store.dispatch({ type: 'busy', busy: true });
    });
    for (const button of screen.getAllByRole('button')) {
      expect(button).toBeDisabled();
    }
    expect(screen.getByLabelText('New branch')).toBeDisabled();
  });
});

describe('creating a branch', () => {
  function type(value: string): void {
    fireEvent.change(screen.getByLabelText('New branch'), { target: { value } });
  }

  it('creates and switches, from the current branch by default', async () => {
    const store = renderLoaded();
    type('feature/y');
    await click(screen.getByRole('button', { name: 'Create and switch' }));
    expect(createMock).toHaveBeenCalledWith(store, 'feature/y', undefined);
  });

  it('uses the selected commit as the start point when asked', async () => {
    const store = renderRefs((prepared) => {
      openRepo(prepared);
      prepared.dispatch({ type: 'branches/loaded', branches: BRANCHES });
      prepared.dispatch({ type: 'stashes/loaded', stashes: STASHES });
      prepared.dispatch({ type: 'selection/commit', oid: 'f'.repeat(40) });
    });
    type('feature/y');
    await click(screen.getByRole('checkbox'));
    await click(screen.getByRole('button', { name: 'Create and switch' }));
    expect(createMock).toHaveBeenCalledWith(store, 'feature/y', 'f'.repeat(40));
  });

  it('cannot offer a start point when nothing is selected', () => {
    renderLoaded();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByText(/no commit selected/)).toBeInTheDocument();
  });

  it('refuses an option-shaped name in the field, without calling git', async () => {
    renderLoaded();
    type('--force');
    await click(screen.getByRole('button', { name: 'Create and switch' }));
    expect(createMock).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'A branch name may not start with a dash.',
    );
    expect(screen.getByLabelText('New branch')).toHaveAttribute('aria-invalid', 'true');
  });

  it.each([
    ['', 'Enter a branch name.'],
    ['my branch', 'A branch name may not contain spaces'],
    ['refs/heads/main', 'Use the short name'],
    ['a..b', 'may not contain ".."'],
  ])('rejects %s in the field', async (name, message) => {
    renderLoaded();
    type(name);
    await click(screen.getByRole('button', { name: 'Create and switch' }));
    expect(createMock).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(message);
  });

  it('reports a refused creation next to the field and keeps the name', async () => {
    createMock.mockResolvedValue(false);
    renderLoaded();
    type('feature/y');
    await click(screen.getByRole('button', { name: 'Create and switch' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Branch "feature/y" was not created.',
    );
    expect(screen.getByLabelText('New branch')).toHaveValue('feature/y');
  });

  it('quotes git when it refused the name the field accepted', async () => {
    const store = renderLoaded();
    createMock.mockImplementation(async () => {
      store.dispatch({
        type: 'notice',
        notice: { tone: 'error', message: 'fatal: not a valid object name: nope' },
      });
      return false;
    });
    type('feature/y');
    await click(screen.getByRole('button', { name: 'Create and switch' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'fatal: not a valid object name: nope',
    );
  });

  it('clears the field after a successful creation', async () => {
    renderLoaded();
    type('feature/y');
    await click(screen.getByRole('button', { name: 'Create and switch' }));
    expect(screen.getByLabelText('New branch')).toHaveValue('');
  });
});

describe('deleting a branch', () => {
  async function askDelete(): Promise<void> {
    await click(screen.getByTitle('Delete feature/x'));
  }

  it('does not delete anything before the question is answered', async () => {
    renderLoaded();
    await askDelete();
    expect(dialog()).toHaveTextContent('Delete branch "feature/x"?');
    expect(removeBranchMock).not.toHaveBeenCalled();
  });

  it('never offers to delete the checked-out branch', () => {
    renderLoaded();
    const disabled = screen.getByTitle(
      'The checked-out branch cannot be deleted. Switch away first.',
    );
    expect(disabled).toBeDisabled();
    expect(disabled.parentElement).toHaveTextContent('main');
    expect(screen.getByTitle('Delete feature/x')).toBeEnabled();
  });

  it('asks git without force first, passing the question the user answered', async () => {
    const store = renderLoaded();
    await askDelete();
    await click(screen.getByRole('button', { name: 'Delete branch' }));
    expect(removeBranchMock).toHaveBeenCalledTimes(1);
    expect(removeBranchMock).toHaveBeenCalledWith(
      store,
      'feature/x',
      'Delete branch "feature/x"?',
      { force: false },
    );
    expect(screen.getByRole('status')).toHaveTextContent('Deleted branch "feature/x".');
  });

  it('shows the unmerged warning and does NOT force until it is confirmed again', async () => {
    removeBranchMock.mockResolvedValue({
      deleted: false,
      unmergedWarning: 'Branch "feature/x" has commits that are not merged anywhere.',
    });
    renderLoaded();
    await askDelete();
    await click(screen.getByRole('button', { name: 'Delete branch' }));

    expect(removeBranchMock).toHaveBeenCalledTimes(1);
    expect(removeBranchMock.mock.calls[0]?.[3]).toEqual({ force: false });
    // Every call so far was a safe one — nothing escalated on its own.
    for (const call of removeBranchMock.mock.calls) {
      expect(call[3]).toEqual({ force: false });
    }
    expect(dialog()).toHaveTextContent(
      'Branch "feature/x" has commits that are not merged anywhere.',
    );
    // Present, but inert: it arrives disarmed so a click aimed at the safe
    // question cannot land on it.
    expect(forceButton()).toBeInTheDocument();
    expect(forceButton()).toBeDisabled();
    await click(forceButton());
    expect(removeBranchMock).toHaveBeenCalledTimes(1);
  });

  it('arms the forcing button only through its own separate gesture', async () => {
    removeBranchMock.mockResolvedValue({
      deleted: false,
      unmergedWarning: 'not merged',
    });
    renderLoaded();
    await askDelete();
    await click(screen.getByRole('button', { name: 'Delete branch' }));
    expect(forceButton()).toBeDisabled();
    await arm();
    expect(forceButton()).toBeEnabled();
  });

  it('forces only on the second confirmation, with its own reason', async () => {
    removeBranchMock.mockResolvedValueOnce({
      deleted: false,
      unmergedWarning: 'not merged',
    });
    removeBranchMock.mockResolvedValueOnce({ deleted: true });
    const store = renderLoaded();
    await askDelete();
    await click(screen.getByRole('button', { name: 'Delete branch' }));
    await arm();
    await click(forceButton());

    expect(removeBranchMock).toHaveBeenCalledTimes(2);
    expect(removeBranchMock).toHaveBeenLastCalledWith(
      store,
      'feature/x',
      'Delete branch "feature/x" anyway, dropping the commits that are not merged anywhere?',
      { force: true },
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('lets the user walk away from the forcing question', async () => {
    removeBranchMock.mockResolvedValue({
      deleted: false,
      unmergedWarning: 'not merged',
    });
    renderLoaded();
    await askDelete();
    await click(screen.getByRole('button', { name: 'Delete branch' }));
    await click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(removeBranchMock).toHaveBeenCalledTimes(1);
  });

  it('puts focus on Cancel when the question becomes the forcing one', async () => {
    removeBranchMock.mockResolvedValue({
      deleted: false,
      unmergedWarning: 'not merged',
    });
    renderLoaded();
    await askDelete();
    await click(screen.getByRole('button', { name: 'Delete branch' }));
    // A keystroke aimed at the first question must not land on the second.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('keeps Tab inside the question while it is open', async () => {
    renderLoaded();
    await askDelete();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Delete branch' });
    expect(document.activeElement).toBe(cancel);

    // Backwards off the first control wraps to the last one inside the
    // question instead of landing on a Delete button behind it.
    fireEvent.keyDown(dialog(), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(dialog(), { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
  });

  it('closes on Escape without deleting', async () => {
    renderLoaded();
    await askDelete();
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(removeBranchMock).not.toHaveBeenCalled();
  });

  it('says the branch survived when the delete did not happen', async () => {
    removeBranchMock.mockResolvedValue(null);
    renderLoaded();
    await askDelete();
    await click(screen.getByRole('button', { name: 'Delete branch' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Branch "feature/x" was not deleted.',
    );
  });

  it('quotes what git reported when the delete failed', async () => {
    const store = renderLoaded();
    removeBranchMock.mockImplementation(async () => {
      store.dispatch({
        type: 'notice',
        notice: { tone: 'error', message: 'error: branch is checked out at /other' },
      });
      return null;
    });
    await askDelete();
    await click(screen.getByRole('button', { name: 'Delete branch' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'error: branch is checked out at /other',
    );
  });

  it('runs one command per answer, even when clicked again mid-flight', async () => {
    let release: (() => void) | null = null;
    removeBranchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ deleted: true });
        }),
    );
    renderLoaded();
    await askDelete();
    const confirm = screen.getByRole('button', { name: 'Delete branch' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await act(async () => {
      release?.();
    });
    expect(removeBranchMock).toHaveBeenCalledTimes(1);
  });

  it('does not reopen a question the user dismissed while it was in flight', async () => {
    let release: (() => void) | null = null;
    removeBranchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ deleted: false, unmergedWarning: 'not merged anywhere' });
        }),
    );
    renderLoaded();
    await askDelete();
    await click(screen.getByRole('button', { name: 'Delete branch' }));
    // Cancelled before git answered: the answer must not put a destructive
    // dialog back on screen.
    await click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => {
      release?.();
    });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('forgets the question rather than resurrecting it on the way back', async () => {
    removeBranchMock.mockResolvedValue({
      deleted: false,
      unmergedWarning: 'not merged anywhere',
    });
    const store = renderLoaded();
    await askDelete();
    await click(screen.getByRole('button', { name: 'Delete branch' }));
    expect(dialog()).toHaveTextContent('not merged anywhere');

    const elsewhere = {
      root: '/other',
      gitDir: '/other/.git',
      bare: false,
      empty: false,
    };
    act(() => store.dispatch({ type: 'repo/opened', repo: elsewhere }));
    act(() =>
      store.dispatch({
        type: 'repo/opened',
        repo: { root: '/repo', gitDir: '/repo/.git', bare: false, empty: false },
      }),
    );
    // Stale evidence about a repository that has moved on since is not shown
    // as though it were fresh.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('does not show a message about one repository over another', async () => {
    const store = renderLoaded();
    await askDelete();
    await click(screen.getByRole('button', { name: 'Delete branch' }));
    expect(screen.getByRole('status')).toHaveTextContent('Deleted branch "feature/x".');

    act(() =>
      store.dispatch({
        type: 'repo/opened',
        repo: { root: '/other', gitDir: '/other/.git', bare: false, empty: false },
      }),
    );
    expect(screen.queryByText('Deleted branch "feature/x".')).not.toBeInTheDocument();
  });

  it('drops the question when the open repository changes', async () => {
    const store = renderLoaded();
    await askDelete();
    act(() =>
      store.dispatch({
        type: 'repo/opened',
        repo: { root: '/other', gitDir: '/other/.git', bare: false, empty: false },
      }),
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(removeBranchMock).not.toHaveBeenCalled();
  });
});

describe('stash list', () => {
  function stashRow(message: string): HTMLElement {
    return screen.getByText(message).closest('li') as HTMLElement;
  }

  it('shows the message, the branch and a relative date', () => {
    renderLoaded();
    const row = within(stashRow('WIP on main: parser'));
    expect(row.getByText('stash@{0}')).toBeInTheDocument();
    expect(row.getByText('on main')).toBeInTheDocument();
    expect(row.getByTitle('2026-08-19T10:00:00Z')).toBeInTheDocument();
  });

  it('distinguishes apply from pop', () => {
    renderLoaded();
    const row = within(stashRow('WIP on main: parser'));
    expect(row.getByRole('button', { name: 'Apply' })).toHaveAttribute(
      'title',
      'Apply stash@{0} and keep it in the list',
    );
    expect(row.getByRole('button', { name: 'Pop' })).toHaveAttribute(
      'title',
      'Apply stash@{0} and remove it from the list',
    );
  });

  it('applies the entry it was rendered from, oid included', async () => {
    const store = renderLoaded();
    await click(
      within(stashRow('WIP on feature/x: layout')).getByRole('button', {
        name: 'Apply',
      }),
    );
    await click(screen.getByRole('button', { name: 'Apply stash' }));
    expect(restoreStashMock).toHaveBeenCalledWith(
      store,
      { ref: 'stash@{1}', oid: 'c'.repeat(40) },
      { pop: false },
      'Apply stash "WIP on feature/x: layout" to the working tree, keeping it in the list?',
    );
  });

  it('pops with the oid, so a shifted list cannot be popped by position', async () => {
    const store = renderLoaded();
    await click(
      within(stashRow('WIP on feature/x: layout')).getByRole('button', {
        name: 'Pop',
      }),
    );
    await click(screen.getByRole('button', { name: 'Pop stash' }));
    expect(restoreStashMock).toHaveBeenCalledWith(
      store,
      { ref: 'stash@{1}', oid: 'c'.repeat(40) },
      { pop: true },
      'Pop stash "WIP on feature/x: layout" — apply it to the working tree and remove it from the list?',
    );
  });

  it('drops with the oid and the question the user answered', async () => {
    const store = renderLoaded();
    await click(
      within(stashRow('WIP on main: parser')).getByRole('button', {
        name: 'Drop',
      }),
    );
    await click(screen.getByRole('button', { name: 'Drop stash' }));
    expect(removeStashMock).toHaveBeenCalledWith(
      store,
      { ref: 'stash@{0}', oid: 'b'.repeat(40) },
      'Drop stash "WIP on main: parser" without applying it?',
    );
  });

  it('does not touch a stash until the question is answered', async () => {
    renderLoaded();
    await click(
      within(stashRow('WIP on main: parser')).getByRole('button', {
        name: 'Drop',
      }),
    );
    expect(dialog()).toHaveTextContent('Drop stash "WIP on main: parser"');
    expect(removeStashMock).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(removeStashMock).not.toHaveBeenCalled();
  });

  it('shows the recovery command after a drop, naming the oid', async () => {
    renderLoaded();
    await click(
      within(stashRow('WIP on main: parser')).getByRole('button', {
        name: 'Drop',
      }),
    );
    await click(screen.getByRole('button', { name: 'Drop stash' }));
    expect(screen.getByRole('status')).toHaveTextContent(
      `git stash apply ${'b'.repeat(40)}`,
    );
  });

  it('reports a refused drop honestly and does not retry', async () => {
    const store = renderLoaded();
    removeStashMock.mockImplementation(async () => {
      store.dispatch({
        type: 'notice',
        notice: {
          tone: 'error',
          message: 'The stash list changed since it was loaded. Refresh and try again.',
        },
      });
      return false;
    });
    await click(
      within(stashRow('WIP on main: parser')).getByRole('button', {
        name: 'Drop',
      }),
    );
    await click(screen.getByRole('button', { name: 'Drop stash' }));

    expect(removeStashMock).toHaveBeenCalledTimes(1);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('did not complete');
    expect(alert).toHaveTextContent('The stash list changed since it was loaded.');
    // No recovery command: nothing was dropped, so nothing can be recovered.
    expect(screen.queryByText(/git stash apply/)).not.toBeInTheDocument();
  });

  it('never claims a failed pop left the working tree alone', async () => {
    const store = renderLoaded();
    restoreStashMock.mockImplementation(async () => {
      store.dispatch({
        type: 'notice',
        notice: { tone: 'error', message: 'CONFLICT (content): Merge conflict in a.ts' },
      });
      return false;
    });
    await click(
      within(stashRow('WIP on main: parser')).getByRole('button', { name: 'Pop' }),
    );
    await click(screen.getByRole('button', { name: 'Pop stash' }));

    const alert = screen.getByRole('alert');
    // A conflicting pop fails *after* writing the working tree, so the panel
    // must not report it as "nothing happened".
    expect(alert).not.toHaveTextContent('did not run');
    expect(alert).toHaveTextContent('did not complete');
    expect(alert).toHaveTextContent('your working tree already contains the changes');
    expect(alert).toHaveTextContent('CONFLICT (content): Merge conflict in a.ts');
  });

  it('keeps the recovery command on screen through later clicks', async () => {
    renderLoaded();
    await click(
      within(stashRow('WIP on main: parser')).getByRole('button', { name: 'Drop' }),
    );
    await click(screen.getByRole('button', { name: 'Drop stash' }));
    expect(screen.getByRole('status')).toHaveTextContent('git stash apply');

    await click(screen.getByRole('button', { name: /feature\/x/ }));
    expect(screen.getByRole('status')).toHaveTextContent(
      `git stash apply ${'b'.repeat(40)}`,
    );
  });

  it('names the repository the dropped stash lives in', async () => {
    renderLoaded();
    await click(
      within(stashRow('WIP on main: parser')).getByRole('button', { name: 'Drop' }),
    );
    await click(screen.getByRole('button', { name: 'Drop stash' }));
    expect(screen.getByRole('status')).toHaveTextContent('/repo');
  });

  it('shows one question at a time', async () => {
    renderLoaded();
    await click(screen.getByTitle('Delete feature/x'));
    await click(
      within(stashRow('WIP on main: parser')).getByRole('button', { name: 'Drop' }),
    );
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    expect(dialog()).toHaveTextContent('Drop stash "WIP on main: parser"');
  });

  it('drops the stash question when the open repository changes', async () => {
    const store = renderLoaded();
    await click(
      within(stashRow('WIP on main: parser')).getByRole('button', { name: 'Drop' }),
    );
    act(() =>
      store.dispatch({
        type: 'repo/opened',
        repo: { root: '/other', gitDir: '/other/.git', bare: false, empty: false },
      }),
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(removeStashMock).not.toHaveBeenCalled();
  });

  it('says which side of pop happened', async () => {
    renderLoaded();
    await click(
      within(stashRow('WIP on main: parser')).getByRole('button', {
        name: 'Pop',
      }),
    );
    await click(screen.getByRole('button', { name: 'Pop stash' }));
    expect(screen.getByRole('status')).toHaveTextContent('it is no longer in the list');
  });

  it('says an applied stash is still there', async () => {
    renderLoaded();
    await click(
      within(stashRow('WIP on main: parser')).getByRole('button', {
        name: 'Apply',
      }),
    );
    await click(screen.getByRole('button', { name: 'Apply stash' }));
    expect(screen.getByRole('status')).toHaveTextContent('it is still in the list');
  });

  it('falls back to the ref for an entry git recorded no message for', () => {
    renderLoaded(BRANCHES, [
      stash({ ref: 'stash@{3}', oid: 'd'.repeat(40), message: '' }),
    ]);
    expect(screen.getAllByText('stash@{3}').length).toBeGreaterThan(0);
  });
});
