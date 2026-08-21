import { describe, expect, it } from 'vitest';
import {
  buildCommitMenu,
  buildStashMenu,
  commitLabel,
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
      1, 3, 4, 2,
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

  it('warns that a rebase rewrites ids others may have pulled', () => {
    const question = rebaseQuestion('main', commit());
    expect(question).toContain('main');
    expect(question).toMatch(/new id/);
    expect(question).toMatch(/pulled/);
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
