import { describe, expect, it } from 'vitest';
import {
  buildCommitMenu,
  buildStashMenu,
  commitLabel,
  mergeQuestion,
  mergeableRefs,
  rebaseQuestion,
  resetQuestion,
  type CommitMenuContext,
  type CommitMenuItem,
} from './commitMenu';
import type { Commit, Remote } from '../../git/types';

const OID = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

function commit(overrides: Partial<Commit> = {}): Commit {
  return {
    oid: OID,
    shortOid: 'a1b2c3d',
    parents: [],
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    authorDate: '2026-08-20T10:00:00+00:00',
    committerName: 'Ada',
    committerDate: '2026-08-20T10:00:00+00:00',
    subject: 'fix the graph',
    body: '',
    refs: [],
    ...overrides,
  };
}

function remote(name: string, fetchUrl: string): Remote {
  return { name, fetchUrl, pushUrl: fetchUrl };
}

function context(overrides: Partial<CommitMenuContext> = {}): CommitMenuContext {
  return {
    commit: commit(),
    branch: 'main',
    busy: false,
    hasConflicts: false,
    hasLocalChanges: false,
    remotes: { state: 'ready', value: [remote('origin', 'git@github.com:o/r.git')] },
    ...overrides,
  };
}

function flatten(sections: CommitMenuItem[][]): CommitMenuItem[] {
  return sections.flatMap((section) =>
    section.flatMap((item) => [item, ...(item.submenu ?? [])]),
  );
}

function item(overrides: Partial<CommitMenuContext>, id: string): CommitMenuItem {
  const found = flatten(buildCommitMenu(context(overrides))).find(
    (candidate) => candidate.id === id,
  );
  if (found === undefined) throw new Error(`no menu item "${id}"`);
  return found;
}

describe('buildCommitMenu', () => {
  it('offers every action in a healthy repository', () => {
    const ids = flatten(buildCommitMenu(context())).map((entry) => entry.id);
    expect(ids).toEqual([
      'checkout',
      'branch',
      'tag',
      'annotated-tag',
      'cherry-pick',
      'revert',
      'merge',
      'rebase',
      'reset',
      'reset-soft',
      'reset-mixed',
      'reset-hard',
      'copy-sha',
      'copy-link',
    ]);
  });

  it('groups the items the way they are drawn', () => {
    expect(buildCommitMenu(context()).map((section) => section.length)).toEqual([
      1, 3, 5, 2,
    ]);
  });

  it('names the branch in the items that move it', () => {
    expect(item({ branch: 'release' }, 'rebase').label).toBe(
      'Rebase release onto this commit',
    );
    expect(item({ branch: 'release' }, 'reset').label).toBe(
      'Reset release to this commit',
    );
  });
});

describe('the push-tag items', () => {
  const tagged = (...names: string[]) => ({
    commit: commit({
      refs: names.map((name) => ({ kind: 'tag' as const, name })),
    }),
  });

  it('is absent on a row with no tag: there is nothing to push', () => {
    const ids = flatten(buildCommitMenu(context())).map((entry) => entry.id);
    expect(ids.some((id) => id.startsWith('push-tag'))).toBe(false);
  });

  it('offers one push per tag, naming the remote it would go to', () => {
    const items = flatten(buildCommitMenu(context(tagged('v1.0', 'v1.1'))));
    const labels = items
      .filter((entry) => entry.id.startsWith('push-tag'))
      .map((entry) => entry.label);
    expect(labels).toEqual(['Push tag v1.0 to origin', 'Push tag v1.1 to origin']);
  });

  it('carries the tag and the remote as the action', () => {
    expect(item(tagged('v1.0'), 'push-tag-v1.0').action).toEqual({
      kind: 'push-tag',
      remote: 'origin',
      tag: 'v1.0',
    });
  });

  it('sits next to the items that create tags', () => {
    // The tag was just made from this same group; the way to publish it should
    // not be somewhere else on the menu.
    const sections = buildCommitMenu(context(tagged('v1.0')));
    const group = sections.find((section) => section.some((entry) => entry.id === 'tag'));
    expect(group?.map((entry) => entry.id)).toEqual([
      'branch',
      'tag',
      'annotated-tag',
      'push-tag-v1.0',
    ]);
  });

  it('says there is nowhere to push when the repository has no remote', () => {
    const found = item(
      { ...tagged('v1.0'), remotes: { state: 'ready', value: [] } },
      'push-tag-v1.0',
    );
    expect(found.disabled).toMatch(/Nowhere to push to/);
    expect(found.action).toBeUndefined();
  });

  it('is disabled with everything else while a command runs', () => {
    expect(
      item({ ...tagged('v1.0'), busy: true }, 'push-tag-v1.0').disabled,
    ).not.toBeNull();
  });
});

describe('the delete items', () => {
  const withRefs = (...refs: { kind: Commit['refs'][number]['kind']; name: string }[]) =>
    ({ commit: commit({ refs }) }) as Partial<CommitMenuContext>;

  it('offers nothing at all on a row with no names', () => {
    expect(flatten(buildCommitMenu(context())).map((entry) => entry.id)).not.toContain(
      'delete-branch-main',
    );
    // An empty section would draw a rule with nothing under it.
    expect(buildCommitMenu(context()).map((section) => section.length)).toEqual([
      1, 3, 5, 2,
    ]);
  });

  it('offers each local branch on the row by name', () => {
    const entry = item(
      withRefs({ kind: 'branch', name: 'feat/quest-line' }),
      'delete-branch-feat/quest-line',
    );
    expect(entry.label).toBe('Delete branch feat/quest-line');
    expect(entry.disabled).toBeNull();
    expect(entry.action).toEqual({ kind: 'delete-branch', name: 'feat/quest-line' });
  });

  it('will not offer to delete the branch that is checked out', () => {
    // git refuses it, and the item is shown rather than hidden so the refusal
    // is the app's answer instead of a missing feature.
    const entry = item(
      { ...withRefs({ kind: 'branch', name: 'main' }), branch: 'main' },
      'delete-branch-main',
    );
    expect(entry.disabled).toContain('the branch you are on');
    expect(entry.action).toBeUndefined();
  });

  it('offers a remote-tracking branch as the remote delete it really is', () => {
    const entry = item(
      withRefs({ kind: 'remote-branch', name: 'origin/feat/x' }),
      'delete-remote-branch-origin/feat/x',
    );
    // The label says where it goes: this one reaches a server other people
    // fetch from, and the local delete two rows up does not.
    expect(entry.label).toBe('Delete feat/x on origin');
    expect(entry.action).toEqual({
      kind: 'delete-remote-branch',
      remote: 'origin',
      branch: 'feat/x',
      // Captured before the delete: the refresh afterwards prunes the ref this
      // row was drawn from, and the oid is the way back.
      oid: OID,
    });
  });

  it('never offers to delete <remote>/HEAD, which is not a branch', () => {
    const ids = flatten(
      buildCommitMenu(context(withRefs({ kind: 'remote-branch', name: 'origin/HEAD' }))),
    ).map((entry) => entry.id);
    expect(ids).not.toContain('delete-remote-branch-origin/HEAD');
  });

  it('leaves HEAD out of it, and offers a tag both of its deletes', () => {
    // HEAD is where the checkout is, not a ref anybody deletes. A tag gets two
    // items because they are two acts: dropping the name here leaves the
    // release tag on the server, and dropping it there takes it from everyone.
    const ids = flatten(
      buildCommitMenu(
        context(withRefs({ kind: 'tag', name: 'v1.0' }, { kind: 'head', name: 'HEAD' })),
      ),
    ).map((entry) => entry.id);
    expect(ids.filter((id) => id.startsWith('delete-'))).toEqual([
      'delete-tag-v1.0',
      'delete-remote-tag-v1.0',
    ]);
  });

  it('names the remote the tag delete would reach', () => {
    const entry = item(withRefs({ kind: 'tag', name: 'v1.0' }), 'delete-remote-tag-v1.0');
    expect(entry.label).toBe('Delete tag v1.0 on origin');
    expect(entry.action).toEqual({
      kind: 'delete-remote-tag',
      remote: 'origin',
      tag: 'v1.0',
    });
  });

  it('cannot delete a tag on a remote that does not exist', () => {
    const entry = item(
      {
        ...withRefs({ kind: 'tag', name: 'v1.0' }),
        remotes: { state: 'ready', value: [] },
      },
      'delete-remote-tag-v1.0',
    );
    expect(entry.disabled).toContain('No remote');
    expect(entry.action).toBeUndefined();
    // The local delete does not need anybody's network.
    expect(
      item(withRefs({ kind: 'tag', name: 'v1.0' }), 'delete-tag-v1.0').action,
    ).toEqual({ kind: 'delete-tag', name: 'v1.0' });
  });

  it('is refused while another command is running, like everything else', () => {
    const entry = item(
      { ...withRefs({ kind: 'branch', name: 'old' }), busy: true },
      'delete-branch-old',
    );
    expect(entry.disabled).toBe('Another git operation is already running.');
  });
});

describe('the merge items', () => {
  const withRefs = (...names: string[]) => ({
    commit: commit({
      refs: names.map((name) => ({
        kind: name.startsWith('origin/')
          ? ('remote-branch' as const)
          : ('branch' as const),
        name,
      })),
    }),
  });

  it('offers one item per branch on the row, into the checked-out branch', () => {
    const items = flatten(
      buildCommitMenu(context(withRefs('feature/x', 'origin/feature/x'))),
    );
    const labels = items
      .filter((entry) => entry.id.startsWith('merge'))
      .map((e) => e.label);
    // Two refs, two merges: `feature/x` and `origin/feature/x` are different
    // merges the moment those refs disagree, which is when somebody looks here.
    expect(labels).toEqual([
      'Merge feature/x into main',
      'Merge origin/feature/x into main',
    ]);
  });

  it('carries the ref name, not the sha, as what gets merged', () => {
    const found = item(withRefs('feature/x'), 'merge-branch-feature/x');
    expect(found.action).toEqual({
      kind: 'merge',
      branch: 'main',
      ref: 'feature/x',
      label: 'feature/x',
    });
  });

  it('never offers to merge the checked-out branch into itself', () => {
    const items = flatten(buildCommitMenu(context(withRefs('main', 'feature/x'))));
    const labels = items
      .filter((entry) => entry.id.startsWith('merge'))
      .map((e) => e.label);
    expect(labels).toEqual(['Merge feature/x into main']);
  });

  it('falls back to the commit itself when the row carries no branch', () => {
    const found = item({}, 'merge');
    expect(found.label).toBe('Merge this commit into main');
    expect(found.action).toMatchObject({ kind: 'merge', ref: OID });
  });

  it('says there is nothing to merge on the row HEAD is already on', () => {
    const found = item(
      { commit: commit({ refs: [{ kind: 'head', name: 'HEAD' }] }) },
      'merge',
    );
    expect(found.disabled).toBe('main is already here, so there is nothing to merge.');
  });

  it('cannot merge into a detached HEAD, and says which of the two it is', () => {
    expect(item({ branch: null }, 'merge').disabled).toMatch(/HEAD is detached/);
    expect(item({ branch: undefined }, 'merge').disabled).toMatch(/not been read yet/);
  });

  it('is disabled with everything else while a command runs', () => {
    expect(item({ busy: true }, 'merge').disabled).not.toBeNull();
    expect(item({ hasConflicts: true }, 'merge').disabled).not.toBeNull();
  });

  it('is offered over a dirty working tree, because git allows that merge', () => {
    // Unlike rebase: git refuses a rebase over uncommitted changes outright,
    // but merges happily as long as no file it must write is one you edited.
    expect(item({ hasLocalChanges: true }, 'merge').disabled).toBeNull();
  });
});

describe('mergeableRefs', () => {
  it('keeps branches and drops tags, HEAD and the checkout', () => {
    const refs = mergeableRefs(
      commit({
        refs: [
          { kind: 'head', name: 'HEAD' },
          { kind: 'branch', name: 'main' },
          { kind: 'branch', name: 'feature/x' },
          { kind: 'remote-branch', name: 'origin/feature/x' },
          { kind: 'tag', name: 'v1.0' },
        ],
      }),
      'main',
    );
    expect(refs.map((ref) => ref.name)).toEqual(['feature/x', 'origin/feature/x']);
  });
});

describe('what the menu refuses to offer', () => {
  it('disables every git command while another one is running', () => {
    const items = flatten(buildCommitMenu(context({ busy: true })));
    for (const entry of items) {
      // Copying text is not a git command and stays available.
      if (entry.id.startsWith('copy')) continue;
      expect(entry.disabled).toMatch(/already running/);
    }
  });

  it('disables every git command while conflicts are unresolved', () => {
    const items = flatten(buildCommitMenu(context({ hasConflicts: true })));
    for (const entry of items) {
      if (entry.id.startsWith('copy')) continue;
      expect(entry.disabled).toMatch(/conflicts/);
    }
  });

  it('refuses rebase and reset on a detached HEAD, and says why', () => {
    expect(item({ branch: null }, 'rebase').disabled).toMatch(/detached/);
    expect(item({ branch: null }, 'reset').disabled).toMatch(/detached/);
    expect(item({ branch: null }, 'reset-hard').disabled).toMatch(/detached/);
  });

  it('offers the rebase over a dirty working tree, and asks for the stash', () => {
    // git refuses to rebase over uncommitted changes; `--autostash` is git's
    // own answer to that, so the menu offers the operation instead of sending
    // the user to a terminal to stash by hand.
    const rebase = item({ hasLocalChanges: true }, 'rebase');

    expect(rebase.disabled).toBeNull();
    expect(rebase.action).toEqual({ kind: 'rebase', branch: 'main', autostash: true });
  });

  it('asks for no stash when there is nothing to stash', () => {
    expect(item({ hasLocalChanges: false }, 'rebase').action).toEqual({
      kind: 'rebase',
      branch: 'main',
      autostash: false,
    });
  });

  it('still offers the operations git runs over a dirty working tree', () => {
    const dirty = { hasLocalChanges: true };
    expect(item(dirty, 'cherry-pick').disabled).toBeNull();
    expect(item(dirty, 'revert').disabled).toBeNull();
    expect(item(dirty, 'branch').disabled).toBeNull();
    expect(item(dirty, 'reset-hard').disabled).toBeNull();
  });

  it('still refuses a detached HEAD, dirty tree or not', () => {
    expect(item({ branch: null, hasLocalChanges: true }, 'rebase').disabled).toMatch(
      /detached/,
    );
  });

  it('carries no action for rebase or reset when there is no branch to name', () => {
    expect(item({ branch: null }, 'rebase').action).toBeUndefined();
    expect(item({ branch: null }, 'reset-hard').action).toBeUndefined();
  });

  it('says "not read yet" rather than "detached" when the status is unknown', () => {
    expect(item({ branch: undefined }, 'rebase').disabled).toMatch(/not been read/);
    expect(item({ branch: undefined }, 'rebase').disabled).not.toMatch(/detached/);
  });

  it('still lets a detached HEAD checkout, branch, tag, cherry-pick and revert', () => {
    for (const id of ['checkout', 'branch', 'tag', 'cherry-pick', 'revert']) {
      expect(item({ branch: null }, id).disabled).toBeNull();
    }
  });
});

describe('the copy items', () => {
  it('copies the full oid, not the abbreviation on screen', () => {
    expect(item({}, 'copy-sha').action).toEqual({
      kind: 'copy',
      text: OID,
      what: 'The commit sha',
    });
  });

  it('stays available while git is busy — it runs no command', () => {
    expect(item({ busy: true }, 'copy-sha').disabled).toBeNull();
    expect(item({ busy: true }, 'copy-link').disabled).toBeNull();
  });

  it('names the remote it would link to', () => {
    expect(item({}, 'copy-link').label).toBe(
      'Copy link to this commit on remote: origin',
    );
  });

  it('prefers origin over the other remotes', () => {
    const remotes = {
      state: 'ready' as const,
      value: [
        remote('upstream', 'git@github.com:up/r.git'),
        remote('origin', 'git@github.com:o/r.git'),
      ],
    };
    expect(item({ remotes }, 'copy-link').action).toEqual({
      kind: 'copy',
      text: `https://github.com/o/r/commit/${OID}`,
      what: 'The link',
    });
  });

  it('falls back to the only remote there is when none is called origin', () => {
    const remotes = {
      state: 'ready' as const,
      value: [remote('upstream', 'git@github.com:up/r.git')],
    };
    expect(item({ remotes }, 'copy-link').label).toMatch(/upstream/);
  });

  it('is disabled with a reason when there is no remote at all', () => {
    const remotes = { state: 'ready' as const, value: [] };
    expect(item({ remotes }, 'copy-link').disabled).toMatch(/no remote/);
  });

  it('is disabled with a reason when the remote has no web address', () => {
    const remotes = {
      state: 'ready' as const,
      value: [remote('origin', 'C:/repos/mirror')],
    };
    const entry = item({ remotes }, 'copy-link');
    expect(entry.disabled).toMatch(/cannot derive a web address/);
    expect(entry.action).toBeUndefined();
  });

  it('says the list is still being read, not that there is no remote', () => {
    const disabled = item({ remotes: { state: 'loading' } }, 'copy-link').disabled;
    expect(disabled).toMatch(/not been read yet/);
  });

  it('reports a failed remote read as a failed read', () => {
    const remotes = { state: 'error' as const, message: 'git exploded' };
    expect(item({ remotes }, 'copy-link').disabled).toMatch(/could not be read/);
  });
});

describe('the questions', () => {
  it('names the commit by short oid and subject', () => {
    expect(commitLabel(commit())).toBe('a1b2c3d — fix the graph');
  });

  it('does not leave a blank where an empty subject was', () => {
    expect(commitLabel(commit({ subject: '' }))).toContain('(no subject)');
  });

  it('only the hard reset warns about destroying the working tree', () => {
    expect(resetQuestion('main', 'hard', commit())).toMatch(/destroyed/);
    expect(resetQuestion('main', 'soft', commit())).not.toMatch(/destroy/);
    expect(resetQuestion('main', 'mixed', commit())).not.toMatch(/destroy/);
  });

  it('says where the changes end up for soft and mixed', () => {
    expect(resetQuestion('main', 'soft', commit())).toMatch(/staged/);
    expect(resetQuestion('main', 'mixed', commit())).toMatch(/unstaged/);
  });

  it('names the branch and the commit in every reset question', () => {
    for (const mode of ['soft', 'mixed', 'hard'] as const) {
      const question = resetQuestion('release', mode, commit());
      expect(question).toContain('release');
      expect(question).toContain('a1b2c3d');
    }
  });

  it('says the uncommitted changes are stashed and brought back', () => {
    const question = rebaseQuestion('main', commit(), { autostash: true });

    expect(question).toMatch(/stashed before the replay/);
    expect(question).toMatch(/brought back after it/);
  });

  it('mentions no stash on a clean tree, since none is created', () => {
    // The question is also the confirmation string the git layer records; it
    // has to be true of the command that actually runs.
    expect(rebaseQuestion('main', commit())).not.toMatch(/stash/i);
  });

  it('warns that a rebase rewrites ids others may have pulled', () => {
    const question = rebaseQuestion('main', commit());
    expect(question).toContain('main');
    expect(question).toMatch(/new id/);
    expect(question).toMatch(/pulled/);
  });
});

describe('mergeQuestion', () => {
  it('says what is added, and that nothing is rewritten', () => {
    const said = mergeQuestion('feature/x', 'main');
    expect(said).toContain('Merge feature/x into main');
    expect(said).toContain('no commit is rewritten');
    // The other side of a merge is untouched, and people fear otherwise.
    expect(said).toContain('Nothing on feature/x changes');
  });
});

describe('buildStashMenu', () => {
  const entry = {
    ref: 'stash@{0}',
    oid: OID,
    index: 0,
    message: 'On main: WIP on main',
    date: '2026-08-20T10:00:00+00:00',
  };
  const healthy = { busy: false, hasConflicts: false };

  it('offers the three things you can do to a stash', () => {
    const ids = buildStashMenu(entry, healthy)
      .flat()
      .map((menuItem) => menuItem.id);
    expect(ids).toEqual(['stash-apply', 'stash-pop', 'stash-drop', 'copy-sha']);
  });

  it('carries the entry, so the git layer can check the ref has not shifted', () => {
    const apply = buildStashMenu(entry, healthy)[0]?.[0];
    expect(apply?.action).toEqual({ kind: 'stash', entry, op: 'apply' });
  });

  it('offers nothing from the commit menu — none of it means anything here', () => {
    const ids = buildStashMenu(entry, healthy)
      .flat()
      .map((menuItem) => menuItem.id);
    for (const absent of ['checkout', 'cherry-pick', 'rebase', 'reset', 'branch']) {
      expect(ids).not.toContain(absent);
    }
  });

  it('disables the three while another git command is running', () => {
    const items = buildStashMenu(entry, { ...healthy, busy: true }).flat();
    for (const menuItem of items) {
      if (menuItem.id === 'copy-sha') continue;
      expect(menuItem.disabled).toMatch(/already running/);
    }
  });

  it('disables the three while conflicts are unresolved', () => {
    const items = buildStashMenu(entry, { ...healthy, hasConflicts: true }).flat();
    expect(items[0]?.disabled).toMatch(/conflicts/);
  });

  it('leaves copying available — it runs no command', () => {
    const items = buildStashMenu(entry, { ...healthy, busy: true }).flat();
    expect(items[items.length - 1]?.disabled).toBeNull();
  });
});
