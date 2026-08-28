import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Branch, RepoStatus } from '../../git/types';
import type { WorktreeSummary } from '../../git/worktrees';
import { switchTo } from '../../state/actions';
import { StoreProvider } from '../../state/hooks';
import { resetOpenRequests, subscribeOpenRequests } from '../../state/openRequests';
import { createStore, type Loadable, type Store } from '../../state/store';
import { CheckoutPicker } from './CheckoutPicker';
import { buildCheckoutMenu, checkoutLabel } from './checkoutMenu';

vi.mock('../../state/actions', () => ({ switchTo: vi.fn() }));
const switchToMock = vi.mocked(switchTo);

const OID = 'a'.repeat(40);

function branch(name: string, overrides: Partial<Branch> = {}): Branch {
  return {
    name,
    current: false,
    oid: OID,
    ahead: 0,
    behind: 0,
    remote: false,
    ...overrides,
  };
}

function worktree(overrides: Partial<WorktreeSummary> = {}): WorktreeSummary {
  return {
    path: 'C:/repos/app-wiki',
    head: OID,
    branch: 'wiki',
    detached: false,
    bare: false,
    locked: null,
    prunable: null,
    main: false,
    changed: 0,
    untracked: 0,
    ...overrides,
  };
}

const ready = <T,>(value: T): Loadable<T> => ({ state: 'ready', value });

function menu(options: {
  branches?: Branch[];
  worktrees?: WorktreeSummary[];
  busy?: boolean;
}) {
  return buildCheckoutMenu({
    branches: ready(options.branches ?? []),
    worktrees: ready(options.worktrees ?? []),
    busy: options.busy ?? false,
    onCheckout: () => {},
    onOpen: () => {},
  });
}

function status(overrides: Partial<RepoStatus> = {}): RepoStatus {
  return {
    branch: 'main',
    head: OID,
    detached: false,
    entries: [],
    hasConflicts: false,
    ...overrides,
  };
}

function renderPicker(prepare: (store: Store) => void = () => {}): Store {
  const store = createStore();
  store.dispatch({
    type: 'repo/opened',
    repo: {
      root: 'C:/repos/app',
      gitDir: 'C:/repos/app/.git',
      bare: false,
      empty: false,
    },
  });
  prepare(store);
  render(
    <StoreProvider store={store}>
      <CheckoutPicker />
    </StoreProvider>,
  );
  return store;
}

beforeEach(() => {
  switchToMock.mockReset().mockResolvedValue(true);
  resetOpenRequests();
});

afterEach(() => {
  cleanup();
  resetOpenRequests();
});

describe('buildCheckoutMenu', () => {
  it('offers the local branches and marks the one you are on', () => {
    const built = menu({
      branches: [branch('main', { current: true }), branch('feature/x')],
    });
    expect(built.branches.map((choice) => choice.label)).toEqual([
      'main (current)',
      'feature/x',
    ]);
  });

  it('leaves remote-tracking branches out — they are not somewhere to stand', () => {
    const built = menu({
      branches: [
        branch('main', { current: true }),
        branch('origin/main', { remote: true }),
      ],
    });
    expect(built.branches).toHaveLength(1);
  });

  it('refuses a branch another worktree holds, and names that worktree', () => {
    // Git refuses this outright: two worktrees may never share a branch. The
    // reason belongs on the item, not in an error after the click.
    const built = menu({
      branches: [branch('main', { current: true }), branch('wiki')],
      worktrees: [worktree({ branch: 'wiki', path: 'C:/repos/app-wiki' })],
    });
    const held = built.branches.find((choice) => choice.id === 'branch:wiki');
    expect(held?.disabled).toContain('C:/repos/app-wiki');
    expect(held?.choose).toBeUndefined();
  });

  it('does not block a branch held by the main worktree — that is this window', () => {
    const built = menu({
      branches: [branch('main', { current: true })],
      worktrees: [worktree({ branch: 'main', main: true, path: 'C:/repos/app' })],
    });
    expect(built.branches[0]?.disabled).toBeNull();
  });

  it('offers every linked worktree, saying which branch is open there', () => {
    const built = menu({
      worktrees: [
        worktree({ path: 'C:/repos/app', main: true }),
        worktree({ path: 'C:/repos/app-wiki', branch: 'wiki' }),
        worktree({ path: 'C:/repos/app-fix', branch: null, detached: true }),
      ],
    });
    expect(built.worktrees.map((choice) => choice.label)).toEqual([
      'C:/repos/app-wiki — wiki',
      'C:/repos/app-fix — detached',
    ]);
  });

  it('refuses to open a worktree whose directory is gone, in git\u2019s words', () => {
    const built = menu({
      worktrees: [worktree({ prunable: 'gitdir file points to non-existent location' })],
    });
    expect(built.worktrees[0]?.disabled).toContain('non-existent location');
    expect(built.worktrees[0]?.choose).toBeUndefined();
  });

  it('offers nothing to run while a git command is going', () => {
    const built = menu({
      branches: [branch('main', { current: true }), branch('feature/x')],
      busy: true,
    });
    expect(built.branches[1]?.choose).toBeUndefined();
  });
});

describe('checkoutLabel', () => {
  it('tells apart a branch, a detached HEAD, an unread status and a failed one', () => {
    expect(checkoutLabel(ready(status()))).toEqual({ text: 'main', muted: false });
    expect(checkoutLabel(ready(status({ branch: null, detached: true })))).toEqual({
      text: 'detached HEAD',
      muted: true,
    });
    expect(checkoutLabel({ state: 'loading' })).toMatchObject({
      text: 'reading status…',
    });
    expect(checkoutLabel({ state: 'error', message: 'nope' })).toMatchObject({
      text: 'status unavailable',
    });
  });
});

describe('CheckoutPicker', () => {
  it('shows the branch it is on', () => {
    renderPicker((store) => store.dispatch({ type: 'status/loaded', status: status() }));
    expect(screen.getByRole('button', { name: /main/ })).toBeInTheDocument();
  });

  it('checks out the branch that was picked', () => {
    const store = renderPicker((current) => {
      current.dispatch({ type: 'status/loaded', status: status() });
      current.dispatch({
        type: 'branches/loaded',
        branches: [branch('main', { current: true }), branch('feature/x')],
      });
    });

    fireEvent.click(screen.getByRole('button', { name: /main/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'feature/x' }));

    expect(switchToMock).toHaveBeenCalledWith(store, 'feature/x');
  });

  it('opens a worktree in a tab instead of checking anything out', () => {
    const opened: string[] = [];
    renderPicker((current) => {
      current.dispatch({ type: 'status/loaded', status: status() });
      current.dispatch({
        type: 'worktrees/loaded',
        worktrees: [worktree({ path: 'C:/repos/app-wiki' })],
      });
    });
    // The app is what turns a path into a tab; the picker only asks.
    const stop = subscribeOpenRequests((path) => {
      opened.push(path);
    });

    fireEvent.click(screen.getByRole('button', { name: /main/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /app-wiki/ }));

    expect(opened).toEqual(['C:/repos/app-wiki']);
    expect(switchToMock).not.toHaveBeenCalled();
    stop();
  });
});
