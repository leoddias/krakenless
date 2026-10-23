import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorktreeSummary } from '../../git/worktrees';
import type { Store } from '../../state/store';
import {
  forceRemoveWorktreeQuestion,
  removeWorktreeDialog,
  removeWorktreeQuestion,
  removeWorktreeRefusal,
} from './worktreeDialog';

const removeWorktreeAt = vi.hoisted(() => vi.fn());
const removeBranch = vi.hoisted(() => vi.fn());
vi.mock('../../state/actions', () => ({ removeWorktreeAt, removeBranch }));

const WIKI: WorktreeSummary = {
  path: 'C:/repos/app-wiki',
  head: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  branch: 'wiki',
  detached: false,
  bare: false,
  locked: null,
  prunable: null,
  main: false,
  changed: 0,
  untracked: 0,
};

const FREE = { busy: false, openInTab: false };
const store = {} as Store;

beforeEach(() => {
  removeWorktreeAt.mockReset();
  removeBranch.mockReset();
});

describe('when a worktree may be removed', () => {
  it('allows an ordinary linked worktree, uncommitted work or not', () => {
    // Uncommitted work is git's to refuse; that refusal is the second question.
    expect(removeWorktreeRefusal(WIKI, FREE)).toBeNull();
    expect(removeWorktreeRefusal({ ...WIKI, changed: 3, untracked: 1 }, FREE)).toBeNull();
  });

  it('refuses while a git command is running', () => {
    expect(removeWorktreeRefusal(WIKI, { ...FREE, busy: true })).toContain(
      'already running',
    );
  });

  it('refuses a locked worktree, saying why it was locked', () => {
    expect(removeWorktreeRefusal({ ...WIKI, locked: 'on a USB drive' }, FREE)).toContain(
      'on a USB drive',
    );
    expect(removeWorktreeRefusal({ ...WIKI, locked: '' }, FREE)).toContain('locked');
  });

  it('refuses one that is open in a tab', () => {
    // The tab's watcher holds the folder on Windows: half a remove.
    expect(removeWorktreeRefusal(WIKI, { ...FREE, openInTab: true })).toContain('tab');
  });

  it('refuses the main worktree', () => {
    expect(removeWorktreeRefusal({ ...WIKI, main: true }, FREE)).toContain('main');
  });
});

describe('the remove dialog', () => {
  it('names the folder that goes, and passes its own sentence as the reason', async () => {
    removeWorktreeAt.mockResolvedValue({ removed: true });
    const dialog = removeWorktreeDialog(store, WIKI, null);

    expect(dialog.question).toBe(removeWorktreeQuestion(WIKI));
    expect(dialog.question).toContain('C:/repos/app-wiki');
    expect(dialog.detail).toContain('"wiki"');
    // The safe form does not protect ignored files; the dialog must not imply it does.
    expect(dialog.detail).toContain('ignored files');
    expect(dialog.danger).toBe(true);
    await dialog.run(dialog.question);
    expect(removeWorktreeAt).toHaveBeenCalledWith(store, WIKI.path, dialog.question, {
      force: false,
    });
  });

  it('asks again, armed, when git refused because of uncommitted work', async () => {
    const dialog = removeWorktreeDialog(store, WIKI, 'wiki');
    const forced = dialog.escalate?.({
      removed: false,
      uncommittedWarning: 'not committed',
    });

    expect(forced?.question).toBe(forceRemoveWorktreeQuestion(WIKI));
    expect(forced?.detail).toBe('not committed');
    expect(forced?.arm).toBeDefined();
    removeWorktreeAt.mockResolvedValue({ removed: true });
    await forced?.run(forced.question);
    expect(removeWorktreeAt).toHaveBeenCalledWith(store, WIKI.path, forced?.question, {
      force: true,
    });
  });

  it('offers the branch delete once the folder is gone, from either step', () => {
    const dialog = removeWorktreeDialog(store, WIKI, 'wiki');

    expect(dialog.escalate?.({ removed: true })?.title).toBe(
      'Also delete the local branch "wiki"?',
    );
    const forced = dialog.escalate?.({ removed: false, uncommittedWarning: 'x' });
    expect(forced?.escalate?.({ removed: true })?.question).toBe('Delete branch "wiki"?');
  });

  it('offers nothing after a failure, or when there is no branch to offer', () => {
    // `null` is a refusal the notice bar already reported (open in a tab, a
    // lock, git's own error): nothing was removed, so nothing follows.
    expect(removeWorktreeDialog(store, WIKI, 'wiki').escalate?.(null)).toBeNull();
    expect(
      removeWorktreeDialog(store, WIKI, null).escalate?.({ removed: true }),
    ).toBeNull();
  });
});
