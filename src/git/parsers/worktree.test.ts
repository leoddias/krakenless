import { describe, expect, it } from 'vitest';
import { GitError } from '../errors';
import { parseWorktrees } from './worktree';

const MAIN = 'C:/repos/app';
const OID = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const OTHER = 'b1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

describe('parseWorktrees', () => {
  it('reads the main worktree and a linked one', () => {
    const worktrees = parseWorktrees(
      `worktree ${MAIN}\nHEAD ${OID}\nbranch refs/heads/main\n\n` +
        `worktree C:/repos/app-wiki\nHEAD ${OTHER}\nbranch refs/heads/wiki\n\n`,
    );

    expect(worktrees).toEqual([
      {
        path: MAIN,
        head: OID,
        branch: 'main',
        detached: false,
        bare: false,
        locked: null,
        prunable: null,
        main: true,
      },
      {
        path: 'C:/repos/app-wiki',
        head: OTHER,
        branch: 'wiki',
        detached: false,
        bare: false,
        locked: null,
        prunable: null,
        main: false,
      },
    ]);
  });

  it('keeps a path that contains spaces whole', () => {
    // The reason `--porcelain` is used at all: the human format puts the path,
    // the sha and the branch on one line, and this path has no unambiguous end.
    const worktrees = parseWorktrees(
      `worktree C:/Users/Ada Lovelace/repos/my app\nHEAD ${OID}\nbranch refs/heads/main\n\n`,
    );
    expect(worktrees[0]?.path).toBe('C:/Users/Ada Lovelace/repos/my app');
  });

  it('reads a detached worktree as having no branch', () => {
    const worktrees = parseWorktrees(
      `worktree ${MAIN}\nHEAD ${OID}\nbranch refs/heads/main\n\n` +
        `worktree C:/repos/app-fix\nHEAD ${OTHER}\ndetached\n\n`,
    );
    expect(worktrees[1]).toMatchObject({ branch: null, detached: true });
  });

  it('only strips the refs/heads prefix, so a branch named heads/x survives', () => {
    const worktrees = parseWorktrees(
      `worktree ${MAIN}\nHEAD ${OID}\nbranch refs/heads/heads/x\n\n`,
    );
    expect(worktrees[0]?.branch).toBe('heads/x');
  });

  it('carries the lock reason, and tells a bare lock from no lock at all', () => {
    const worktrees = parseWorktrees(
      `worktree ${MAIN}\nHEAD ${OID}\nbranch refs/heads/main\n\n` +
        `worktree D:/detachable\nHEAD ${OTHER}\ndetached\nlocked on a removable drive\n\n` +
        `worktree E:/other\nHEAD ${OTHER}\ndetached\nlocked\n\n`,
    );
    expect(worktrees[0]?.locked).toBeNull();
    expect(worktrees[1]?.locked).toBe('on a removable drive');
    // Locked without a reason is still locked; `''` is not `null`.
    expect(worktrees[2]?.locked).toBe('');
  });

  it('carries why a worktree is prunable', () => {
    const worktrees = parseWorktrees(
      `worktree C:/gone\nHEAD ${OID}\nbranch refs/heads/x\nprunable gitdir file points to non-existent location\n\n`,
    );
    expect(worktrees[0]?.prunable).toBe('gitdir file points to non-existent location');
  });

  it('reads a bare repository, which has no files and no branch', () => {
    const worktrees = parseWorktrees(`worktree C:/repos/app.git\nbare\n\n`);
    expect(worktrees[0]).toMatchObject({ bare: true, head: null, branch: null });
  });

  it('marks only the first record as the main worktree', () => {
    const worktrees = parseWorktrees(
      `worktree ${MAIN}\nHEAD ${OID}\nbranch refs/heads/main\n\n` +
        `worktree C:/a\nHEAD ${OTHER}\ndetached\n\n` +
        `worktree C:/b\nHEAD ${OTHER}\ndetached\n\n`,
    );
    expect(worktrees.map((tree) => tree.main)).toEqual([true, false, false]);
  });

  it('tolerates a trailing record with no blank line after it', () => {
    const worktrees = parseWorktrees(
      `worktree ${MAIN}\nHEAD ${OID}\nbranch refs/heads/main`,
    );
    expect(worktrees).toHaveLength(1);
  });

  it('survives CRLF, which is how this output arrives on Windows', () => {
    const worktrees = parseWorktrees(
      `worktree ${MAIN}\r\nHEAD ${OID}\r\nbranch refs/heads/main\r\n\r\n`,
    );
    expect(worktrees[0]).toMatchObject({ path: MAIN, branch: 'main' });
  });

  it('ignores a key a newer git added', () => {
    const worktrees = parseWorktrees(
      `worktree ${MAIN}\nHEAD ${OID}\nbranch refs/heads/main\nsomething-new yes\n\n`,
    );
    expect(worktrees).toHaveLength(1);
  });

  it('reads no worktrees from no output', () => {
    expect(parseWorktrees('')).toEqual([]);
  });

  it('refuses output that describes a worktree before naming it', () => {
    // Attaching a lock or a branch to the wrong directory is worse than no list.
    expect(() => parseWorktrees(`HEAD ${OID}\nbranch refs/heads/main\n\n`)).toThrow(
      GitError,
    );
  });

  it('refuses a worktree record with no path', () => {
    expect(() => parseWorktrees(`worktree\nHEAD ${OID}\n\n`)).toThrow(GitError);
  });
});
