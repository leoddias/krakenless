import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Commit, RepoStatus } from '../../git/types';
import { StoreProvider } from '../../state/hooks';
import { createStore, type Store } from '../../state/store';
import { HistoryView } from './HistoryView';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const OID = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

function raw(stdout = '') {
  return { stdout, stderr: '', code: 0, timed_out: false, stdout_lossy: false };
}

function commit(): Commit {
  return {
    oid: OID,
    shortOid: 'a1b2c3d',
    parents: [],
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    authorDate: '2026-08-17T12:00:00Z',
    committerName: 'Ada',
    committerDate: '2026-08-17T12:00:00Z',
    subject: 'fix the graph',
    body: '',
    refs: [],
  };
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

function renderHistory(overrides: { status?: RepoStatus } = {}): Store {
  const store = createStore();
  store.dispatch({
    type: 'repo/opened',
    repo: { root: 'C:/repo', gitDir: 'C:/repo/.git', bare: false, empty: false },
  });
  store.dispatch({ type: 'commits/loaded', commits: [commit()] });
  store.dispatch({ type: 'status/loaded', status: overrides.status ?? status() });
  store.dispatch({
    type: 'remotes/loaded',
    remotes: [
      {
        name: 'origin',
        fetchUrl: 'git@github.com:o/r.git',
        pushUrl: 'git@github.com:o/r.git',
      },
    ],
  });
  render(
    <StoreProvider store={store}>
      <HistoryView />
    </StoreProvider>,
  );
  return store;
}

/** Right-clicks the one commit row and returns the menu that opens. */
function openMenu(): HTMLElement {
  const row = screen.getByRole('button', { name: /fix the graph/ });
  fireEvent.contextMenu(row);
  return screen.getByRole('menu', { name: /Actions for commit a1b2c3d/ });
}

/**
 * Subcommands this menu can start. Selecting a commit re-reads its diff, so the
 * assertions filter to the write side — otherwise "nothing ran" would be false
 * for every test that had to open the menu first.
 */
const WRITES = new Set([
  'switch',
  'branch',
  'tag',
  'cherry-pick',
  'revert',
  'rebase',
  'reset',
  // The HEAD guard the git layer runs before a rebase or a reset.
  'symbolic-ref',
]);

/** Every write (and its guard) the app has invoked so far. */
function invocations(): string[][] {
  return invoke.mock.calls
    .filter((call) => call[0] === 'git_run')
    .map((call) => call[1].args as string[])
    .filter((args) => WRITES.has(args[0] ?? ''));
}

function ran(...args: string[]): boolean {
  return invocations().some(
    (actual) => actual.length === args.length && actual.every((a, i) => a === args[i]),
  );
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(raw());
});

afterEach(cleanup);

describe('opening the menu', () => {
  it('opens on a right-click on a commit', () => {
    renderHistory();
    expect(openMenu()).toBeTruthy();
  });

  it('selects the commit it is about, so the diff below agrees with it', () => {
    const store = renderHistory();
    openMenu();
    expect(store.getState().selection.commitOid).toBe(OID);
  });

  it('does not open on the working-tree row — there is no commit to act on', () => {
    renderHistory();
    fireEvent.contextMenu(screen.getByRole('button', { name: /Working tree/ }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes without running anything when Escape is pressed', () => {
    renderHistory();
    fireEvent.keyDown(openMenu(), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(invocations()).toEqual([]);
  });
});

describe('the items that run straight away', () => {
  it('checks the commit out, detached', async () => {
    renderHistory();
    openMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Checkout this commit' }));
    });
    expect(ran('switch', '--detach', OID)).toBe(true);
  });

  it('cherry-picks it', async () => {
    renderHistory();
    openMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Cherry pick commit' }));
    });
    expect(ran('cherry-pick', OID)).toBe(true);
  });

  it('reverts it without letting git open an editor', async () => {
    renderHistory();
    openMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Revert commit' }));
    });
    expect(ran('revert', '--no-edit', OID)).toBe(true);
  });
});

describe('creating a branch here', () => {
  it('asks for a name before doing anything', () => {
    renderHistory();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create branch here' }));
    expect(
      screen.getByRole('dialog', { name: /Create a branch at a1b2c3d/ }),
    ).toBeTruthy();
    expect(invocations()).toEqual([]);
  });

  it('creates and switches to it, at the commit that was right-clicked', async () => {
    renderHistory();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create branch here' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hotfix' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    expect(ran('switch', '--create', 'hotfix', OID)).toBe(true);
  });

  it('creates without switching when the box is unticked', async () => {
    renderHistory();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create branch here' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hotfix' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Switch to the new branch/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    expect(ran('branch', 'hotfix', OID)).toBe(true);
  });

  it('refuses a name that would read as an option, in the field', async () => {
    renderHistory();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create branch here' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '--force' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    expect(screen.getByRole('alert').textContent).toMatch(/may not start with a dash/);
    expect(invocations()).toEqual([]);
  });

  it('runs nothing when the question is cancelled', () => {
    renderHistory();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create branch here' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(invocations()).toEqual([]);
  });
});

describe('creating a tag here', () => {
  it('creates a lightweight tag at the commit', async () => {
    renderHistory();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create tag here' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'v1.0' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    expect(ran('tag', 'v1.0', OID)).toBe(true);
  });

  it('will not create an annotated tag without a message', async () => {
    renderHistory();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create annotated tag here' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Name/ }), {
      target: { value: 'v1.0' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    expect(screen.getByRole('alert').textContent).toMatch(/needs a message/);
    expect(invocations()).toEqual([]);
  });

  it('creates an annotated tag once it has one', async () => {
    renderHistory();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create annotated tag here' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Name/ }), {
      target: { value: 'v1.0' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: /Message/ }), {
      target: { value: 'ship it' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    expect(ran('tag', '--annotate', '--message', 'ship it', 'v1.0', OID)).toBe(true);
  });
});

describe('the destructive items', () => {
  /** Opens the reset submenu and picks one mode. */
  function chooseReset(label: string): void {
    fireEvent.click(screen.getByRole('menuitem', { name: /Reset main to this commit/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: label }));
  }

  it('asks before resetting, and names the branch and the commit', () => {
    renderHistory();
    openMenu();
    chooseReset('Hard — discard the changes');
    const dialog = screen.getByRole('dialog', { name: /Reset main to this commit\?/ });
    expect(dialog.textContent).toContain('a1b2c3d');
    expect(invocations()).toEqual([]);
  });

  it('warns that a hard reset destroys uncommitted work', () => {
    renderHistory();
    openMenu();
    chooseReset('Hard — discard the changes');
    expect(screen.getByRole('dialog').textContent).toMatch(/destroyed/);
  });

  it('does not warn about destruction for a soft reset', () => {
    renderHistory();
    openMenu();
    chooseReset('Soft — keep the changes staged');
    expect(screen.getByRole('dialog').textContent).not.toMatch(/destroy/);
  });

  it('runs nothing when the reset question is cancelled', () => {
    renderHistory();
    openMenu();
    chooseReset('Hard — discard the changes');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(invocations()).toEqual([]);
  });

  it('checks HEAD is still on the branch before it resets', async () => {
    renderHistory();
    invoke.mockResolvedValue(raw('main\n'));
    openMenu();
    chooseReset('Hard — discard the changes');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Reset/ }));
    });
    const [first, second] = invocations();
    expect(first).toEqual(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    expect(second).toEqual(['reset', '--hard', OID]);
  });

  it('does not reset when HEAD moved to another branch in the meantime', async () => {
    renderHistory();
    openMenu();
    chooseReset('Hard — discard the changes');
    invoke.mockResolvedValue(raw('release\n'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Reset/ }));
    });
    expect(ran('reset', '--hard', OID)).toBe(false);
  });

  it('asks before rebasing, and says the ids are rewritten', () => {
    renderHistory();
    openMenu();
    fireEvent.click(
      screen.getByRole('menuitem', { name: /Rebase main onto this commit/ }),
    );
    expect(screen.getByRole('dialog').textContent).toMatch(/new id/);
    expect(invocations()).toEqual([]);
  });

  it('rebases once confirmed', async () => {
    renderHistory();
    invoke.mockResolvedValue(raw('main\n'));
    openMenu();
    fireEvent.click(
      screen.getByRole('menuitem', { name: /Rebase main onto this commit/ }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Rebase' }));
    });
    expect(ran('rebase', OID)).toBe(true);
  });

  it('offers neither rebase nor reset on a detached HEAD, and says why', () => {
    renderHistory({ status: status({ detached: true, branch: null }) });
    openMenu();
    const rebase = screen.getByRole('menuitem', { name: /Rebase/ });
    expect(rebase.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getAllByText(/detached/).length).toBeGreaterThan(0);
  });

  it('offers nothing that writes while conflicts are unresolved', () => {
    renderHistory({ status: status({ hasConflicts: true }) });
    const menu = openMenu();
    const checkout = within(menu).getByRole('menuitem', {
      name: 'Checkout this commit',
    });
    expect(checkout.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('the copy items', () => {
  it('copies the full sha, not the abbreviation on screen', async () => {
    const writeText = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const store = renderHistory();
    openMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Copy commit sha' }));
    });
    expect(writeText).toHaveBeenCalledWith(OID);
    expect(store.getState().notice?.message).toMatch(/copied/);
  });

  it('copies a web link built from the remote', async () => {
    const writeText = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    renderHistory();
    openMenu();
    await act(async () => {
      fireEvent.click(
        screen.getByRole('menuitem', {
          name: /Copy link to this commit on remote: origin/,
        }),
      );
    });
    expect(writeText).toHaveBeenCalledWith(`https://github.com/o/r/commit/${OID}`);
  });

  it('says so when the clipboard refuses, rather than claiming success', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn().mockReturnValue(false),
      configurable: true,
    });

    const store = renderHistory();
    openMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Copy commit sha' }));
    });
    expect(store.getState().notice?.tone).toBe('warning');
  });
});
