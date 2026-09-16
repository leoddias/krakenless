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

function commit(refs: Commit['refs'] = []): Commit {
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
    refs,
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

/** A status on `main`, tracking `origin/main` and ahead of it. */
function tracking(overrides: Partial<RepoStatus> = {}): RepoStatus {
  return status({ upstream: 'origin/main', ahead: 1, behind: 0, ...overrides });
}

function renderHistory(
  overrides: { status?: RepoStatus; refs?: Commit['refs'] } = {},
): Store {
  const store = createStore();
  store.dispatch({
    type: 'repo/opened',
    repo: { root: 'C:/repo', gitDir: 'C:/repo/.git', bare: false, empty: false },
  });
  store.dispatch({ type: 'commits/loaded', commits: [commit(overrides.refs)] });
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
  'push',
  'merge',
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

  it('opens the working tree menu there, not the commit one', () => {
    // The working-tree row has no commit, so none of these items apply to it.
    // It has a menu of its own now (ADR-0053) — what must not happen is the
    // commit menu appearing over a row there is no commit for.
    renderHistory();
    fireEvent.contextMenu(screen.getByRole('button', { name: /Working tree/ }));
    expect(screen.queryByRole('menuitem', { name: /Check out this commit/ })).toBeNull();
    expect(
      screen.queryByRole('menuitem', { name: /Stash tracked changes/ }),
    ).not.toBeNull();
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

describe('publishing a tag', () => {
  /** A row carrying a tag that exists only here. */
  function withTag(): Store {
    const store = renderHistory();
    // Inside `act`, or the row still holds the untagged commit when the menu
    // reads it and the item under test is never built.
    act(() => {
      store.dispatch({
        type: 'commits/loaded',
        commits: [{ ...commit(), refs: [{ kind: 'tag', name: 'v1.0' }] }],
      });
    });
    return store;
  }

  it('pushes the tag by name, fully qualified', async () => {
    withTag();
    openMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Push tag v1.0 to origin' }));
    });

    expect(ran('push', '--progress', 'origin', 'refs/tags/v1.0:refs/tags/v1.0')).toBe(
      true,
    );
  });

  it('says so afterwards, because nothing on screen would otherwise change', async () => {
    const store = withTag();
    openMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Push tag v1.0 to origin' }));
    });

    expect(store.getState().notice?.message).toBe('Pushed tag v1.0 to origin.');
  });

  it('offers to push a tag as it is created, off by default', async () => {
    renderHistory();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create tag here' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'v2.0' } });

    const push = screen.getByRole('checkbox', { name: /Push it to origin/ });
    // A tag is often made to mark something here long before anyone else
    // should see it, and publishing one cannot be undone from this app.
    expect(push).not.toBeChecked();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    expect(ran('tag', 'v2.0', OID)).toBe(true);
    expect(invocations().some((args) => args[0] === 'push')).toBe(false);
  });

  it('creates and then pushes when that box is ticked', async () => {
    renderHistory();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create tag here' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'v2.0' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Push it to origin/ }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });

    const writes = invocations().map((args) => args[0]);
    // In that order: pushing a name git refused to create would report a
    // second failure about the first one.
    expect(writes.indexOf('tag')).toBeLessThan(writes.indexOf('push'));
    expect(ran('push', '--progress', 'origin', 'refs/tags/v2.0:refs/tags/v2.0')).toBe(
      true,
    );
  });

  it('sends the branch to the same remote, before the tag', async () => {
    renderHistory({ status: tracking() });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create tag here' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'v2.0' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Push it and main to origin/ }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });

    expect(ran('push', '--progress', 'origin', 'refs/heads/main:refs/heads/main')).toBe(
      true,
    );
    const pushes = invocations()
      .filter((args) => args[0] === 'push')
      .map((args) => args[3]);
    // The branch first: the remote has the history the tag points into before
    // the tag names it.
    expect(pushes).toEqual([
      'refs/heads/main:refs/heads/main',
      'refs/tags/v2.0:refs/tags/v2.0',
    ]);
  });

  it('leaves the branch alone when the box is not ticked', async () => {
    renderHistory({ status: tracking() });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create tag here' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'v2.0' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });

    expect(invocations().some((args) => args[0] === 'push')).toBe(false);
  });

  it('pushes the tag alone when the branch is behind, and says only that', async () => {
    // git would refuse the branch push as a non-fast-forward, so it is not
    // offered — the same refusal the remote toolbar's Push button makes.
    renderHistory({ status: tracking({ ahead: 0, behind: 2 }) });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create tag here' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'v2.0' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Push it to origin/ }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });

    const pushes = invocations()
      .filter((args) => args[0] === 'push')
      .map((args) => args[3]);
    expect(pushes).toEqual(['refs/tags/v2.0:refs/tags/v2.0']);
  });

  it('pushes the tag alone when the branch tracks a differently-named upstream', async () => {
    renderHistory({
      status: status({ upstream: 'origin/release', ahead: 1, behind: 0 }),
    });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create tag here' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'v2.0' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Push it to origin/ }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });

    const pushes = invocations()
      .filter((args) => args[0] === 'push')
      .map((args) => args[3]);
    expect(pushes).toEqual(['refs/tags/v2.0:refs/tags/v2.0']);
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
    expect(ran('rebase', '--autostash', OID)).toBe(true);
  });

  it('rebases over uncommitted changes instead of refusing, and says it will stash', async () => {
    // git will not rebase over a dirty tree; --autostash is its own answer to
    // that, so the item is offered and the question says what happens.
    const dirty = status({
      entries: [
        { path: 'a.ts', index: 'unmodified', worktree: 'modified', conflicted: false },
      ],
    });
    renderHistory({ status: dirty });
    invoke.mockResolvedValue(raw('main\n'));
    openMenu();

    const item = screen.getByRole('menuitem', { name: /Rebase main onto this commit/ });
    expect(item.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(item);
    expect(screen.getByRole('dialog').textContent).toMatch(/stashed before the replay/);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Rebase' }));
    });
    expect(ran('rebase', '--autostash', OID)).toBe(true);
  });

  it('warns when the stashed changes did not come back cleanly', async () => {
    // git exits 0 here. Without this notice the rebase reads as a success while
    // the working tree holds conflict markers and the work sits in a stash the
    // user was never told about.
    const store = renderHistory();
    invoke.mockImplementation(async (_name: string, payload: { args: string[] }) =>
      payload.args[0] === 'rebase'
        ? raw(
            'Applying autostash resulted in conflicts.\nYour changes are safe in the stash.\nSuccessfully rebased and updated refs/heads/main.\n',
          )
        : raw('main\n'),
    );
    openMenu();
    fireEvent.click(
      screen.getByRole('menuitem', { name: /Rebase main onto this commit/ }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Rebase' }));
    });

    const notice = store.getState().notice;
    expect(notice?.tone).toBe('warning');
    expect(notice?.message).toMatch(/still in the stash/);
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

describe('deleting a branch from the row it is on', () => {
  const BRANCH_ROW = [{ kind: 'branch' as const, name: 'old' }];
  const REMOTE_ROW = [{ kind: 'remote-branch' as const, name: 'origin/old' }];

  /** Opens the menu and chooses the item whose label matches. */
  function choose(label: RegExp): void {
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: label }));
  }

  it('asks before deleting a local branch, and runs the safe form', async () => {
    renderHistory({ refs: BRANCH_ROW });
    choose(/Delete branch old/);

    expect(screen.getByRole('dialog', { name: 'Delete branch "old"?' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete Branch' }));
    });

    // `-d`, never `-D`: forcing is a separate decision with the warning in view.
    expect(ran('branch', '-d', 'old')).toBe(true);
    expect(ran('branch', '-D', 'old')).toBe(false);
  });

  it('does nothing when the question is cancelled', () => {
    renderHistory({ refs: BRANCH_ROW });
    choose(/Delete branch old/);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(invocations().some((args) => args[0] === 'branch')).toBe(false);
  });

  it('asks a second time when git refuses, and arms the forcing button', async () => {
    renderHistory({ refs: BRANCH_ROW });
    invoke.mockImplementation(async (_name: string, payload: { args: string[] }) =>
      payload.args[0] === 'branch' && payload.args[1] === '-d'
        ? {
            stdout: '',
            stderr: "error: the branch 'old' is not fully merged",
            code: 1,
            timed_out: false,
            stdout_lossy: false,
          }
        : raw(),
    );
    choose(/Delete branch old/);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete Branch' }));
    });

    // A refusal is a second question, not a failure: git's warning is on
    // screen, and the button that drops the commits starts disarmed.
    expect(screen.getByRole('dialog', { name: 'Delete "old" anyway?' })).toBeTruthy();
    expect(screen.getByText(/Deleting it will drop them/)).toBeTruthy();
    const confirm = screen.getByRole('button', { name: 'Delete Branch' });
    expect(confirm).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox', { name: /commits will be lost/ }));
    expect(confirm).toBeEnabled();
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(ran('branch', '-D', 'old')).toBe(true);
  });

  it('deletes a remote branch through a push, fully qualified', async () => {
    renderHistory({ refs: REMOTE_ROW });
    choose(/Delete old on origin/);

    expect(screen.getByRole('dialog', { name: 'Delete "old" on origin?' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete on origin' }));
    });

    // `--delete refs/heads/old`, never the bare name: with only a same-named
    // tag present, the short form deletes the tag.
    expect(ran('push', '--progress', 'origin', '--delete', 'refs/heads/old')).toBe(true);
  });

  it('offers the push that puts a deleted remote branch back', async () => {
    const store = renderHistory({ refs: REMOTE_ROW });
    choose(/Delete old on origin/);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete on origin' }));
    });

    // The oid is only knowable before the delete — the refresh afterwards
    // prunes the ref the row was drawn from.
    expect(store.getState().notice?.undoHint).toBe(
      `git push origin ${OID}:refs/heads/old`,
    );
  });

  it('will not offer to delete the branch that is checked out', () => {
    renderHistory({ refs: [{ kind: 'branch', name: 'main' }] });
    openMenu();

    const entry = screen.getByRole('menuitem', { name: /Delete branch main/ });
    expect(entry).toHaveAttribute('aria-disabled', 'true');
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
