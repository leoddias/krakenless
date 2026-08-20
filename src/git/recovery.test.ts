import { describe, expect, it } from 'vitest';
import { quotePath, recoveryFor, unrecoverableNote } from './recovery';

describe('quotePath', () => {
  it('quotes a plain path', () => {
    expect(quotePath('src/app.ts')).toBe('"src/app.ts"');
  });

  it('escapes what a shell would otherwise interpret', () => {
    // The user copies this into their own shell; an unescaped `$` or quote
    // turns the recovery command into something else entirely.
    expect(quotePath('a"b')).toBe('"a\\"b"');
    expect(quotePath('$HOME/x')).toBe('"\\$HOME/x"');
    expect(quotePath('a`b')).toBe('"a\\`b"');
  });
});

describe('recoveryFor', () => {
  it('restores from the worktree side only', () => {
    // `git checkout <oid> -- <path>` would write the index too, destroying the
    // staged snapshot the discard deliberately preserved.
    const plan = recoveryFor('abc123', ['a.txt'], ['a.txt']);
    expect(plan.commands).toEqual(['git restore --source=abc123 --worktree -- "a.txt"']);
    expect(plan.commands[0]).not.toContain('checkout');
  });

  it('names only the paths the source tree actually holds', () => {
    // `git restore` aborts wholesale on a pathspec it cannot match, so naming a
    // missing path would break recovery for the paths that would have worked.
    const plan = recoveryFor('abc123', ['kept.txt', 'gone.txt'], ['kept.txt']);
    expect(plan.commands[0]).toContain('"kept.txt"');
    expect(plan.commands[0]).not.toContain('gone.txt');
    expect(plan.unrecoverable).toEqual(['gone.txt']);
  });

  it('offers no command when nothing can be restored this way', () => {
    const plan = recoveryFor('abc123', ['gone.txt'], []);
    expect(plan.commands).toEqual([]);
    expect(plan.unrecoverable).toEqual(['gone.txt']);
  });

  it('puts several restorable paths in one command', () => {
    const plan = recoveryFor('abc123', ['a.txt', 'b.txt'], ['a.txt', 'b.txt']);
    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0]).toContain('"a.txt" "b.txt"');
  });
});

describe('unrecoverableNote', () => {
  it('says nothing when everything is covered', () => {
    expect(unrecoverableNote('abc123', [])).toBeNull();
  });

  it('names the stash so the user can look inside it', () => {
    const note = unrecoverableNote('abc123', ['gone.txt']);
    expect(note).toContain('"gone.txt"');
    expect(note).toContain('git stash show -p abc123');
  });
});
