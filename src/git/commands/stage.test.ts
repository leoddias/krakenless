import { describe, expect, it } from 'vitest';
import {
  buildApplyCachedCommand,
  buildApplyCheckCommand,
  buildCommitCommand,
  buildDiscardCommand,
  buildStageCommand,
  buildStashApplyCommand,
  buildStashDropCommand,
  buildStashListCommand,
  buildUnstageCommand,
} from './stage';
import { isDestructive } from '../destructive';
import { GitError } from '../errors';

describe('buildStageCommand', () => {
  it('puts paths after the separator', () => {
    expect(buildStageCommand(['src/app.ts']).args).toEqual(['add', '--', 'src/app.ts']);
  });

  it('is not treated as destructive — staging is recoverable', () => {
    expect(isDestructive(buildStageCommand(['a.txt']).args)).toBe(false);
  });

  it('refuses an empty selection instead of staging everything', () => {
    expect(() => buildStageCommand([])).toThrow(GitError);
  });

  it('keeps a path that looks like a flag safe', () => {
    expect(buildStageCommand(['--force']).args).toEqual(['add', '--', '--force']);
  });
});

describe('buildUnstageCommand', () => {
  it('only rewrites the index', () => {
    expect(buildUnstageCommand(['a.txt']).args).toEqual([
      'restore',
      '--staged',
      '--',
      'a.txt',
    ]);
  });

  it('goes through the confirmation gate', () => {
    const command = buildUnstageCommand(['a.txt']);
    expect(command.destructive).toBe(true);
    expect(isDestructive(command.args)).toBe(true);
  });
});

describe('apply builders', () => {
  it('stages a patch through the index only', () => {
    // Without --cached a bad patch would rewrite files the user is editing.
    expect(buildApplyCachedCommand({ reverse: false }).args).toEqual([
      'apply',
      '--cached',
      '--whitespace=nowarn',
      '-',
    ]);
  });

  it('only disables the context check for hunks that have no context', () => {
    // --unidiff-zero turns off the safety check that catches a patch aimed at
    // the wrong place in the file.
    expect(buildApplyCachedCommand({ reverse: false }).args).not.toContain(
      '--unidiff-zero',
    );
    expect(buildApplyCachedCommand({ reverse: false, zeroContext: true }).args).toContain(
      '--unidiff-zero',
    );
  });

  it('marks the reverse direction destructive', () => {
    const command = buildApplyCachedCommand({ reverse: true });
    expect(command.args).toContain('--reverse');
    expect(command.destructive).toBe(true);
  });

  it('offers a dry run that changes nothing', () => {
    expect(buildApplyCheckCommand({ reverse: false }).args).toContain('--check');
  });
});

describe('buildCommitCommand', () => {
  it('passes the message as its own argument', () => {
    // A message starting with a dash must never be read as an option.
    expect(buildCommitCommand({ message: '--amend everything' }).args).toEqual([
      'commit',
      '--message',
      '--amend everything',
    ]);
  });

  it('refuses an empty message', () => {
    expect(() => buildCommitCommand({ message: '   ' })).toThrow(/message is required/);
  });

  it('marks amend destructive, plain commit not', () => {
    expect(buildCommitCommand({ message: 'x', amend: true }).destructive).toBe(true);
    expect(buildCommitCommand({ message: 'x' }).destructive).toBe(false);
  });

  it('adds --allow-empty only when asked', () => {
    expect(buildCommitCommand({ message: 'x' }).args).not.toContain('--allow-empty');
    expect(buildCommitCommand({ message: 'x', allowEmpty: true }).args).toContain(
      '--allow-empty',
    );
  });
});

describe('buildDiscardCommand', () => {
  it('discards a tracked path by stashing, keeping the staged snapshot', () => {
    // Without --keep-index the stash also reverts staged content to HEAD, and
    // nothing brings that back.
    expect(buildDiscardCommand(['a.txt'], 'label', { keepIndex: true }).args).toEqual([
      'stash',
      'push',
      '--keep-index',
      '--include-untracked',
      '--message',
      'label',
      '--',
      'a.txt',
    ]);
  });

  it('drops --keep-index for untracked paths, which git rejects with it', () => {
    // Verified against git 2.39: --keep-index with an untracked pathspec fails
    // with "did not match any file(s) known to git".
    expect(
      buildDiscardCommand(['new.txt'], 'label', { keepIndex: false }).args,
    ).not.toContain('--keep-index');
  });

  it('never builds a plain restore of the working tree', () => {
    // `git restore --worktree` would be unrecoverable; that is the whole point.
    expect(
      buildDiscardCommand(['a.txt'], 'label', { keepIndex: true }).args,
    ).not.toContain('restore');
  });

  it('requires confirmation', () => {
    const command = buildDiscardCommand(['a.txt'], 'label', { keepIndex: true });
    expect(command.destructive).toBe(true);
    expect(isDestructive(command.args)).toBe(true);
  });

  it('refuses an empty path list, which would discard the whole tree', () => {
    expect(() => buildDiscardCommand([], 'label', { keepIndex: true })).toThrow(GitError);
  });
});

describe('stash builders', () => {
  it('lists with NUL-separated fields', () => {
    expect(buildStashListCommand().args).toEqual([
      'stash',
      'list',
      '-z',
      '--format=%gd%x00%H%x00%aI%x00%gs',
    ]);
  });

  it('separates apply from pop, and only pop is destructive', () => {
    expect(buildStashApplyCommand('stash@{0}', { pop: false }).destructive).toBeFalsy();
    expect(buildStashApplyCommand('stash@{0}', { pop: true }).destructive).toBe(true);
  });

  it('validates the stash ref', () => {
    expect(() => buildStashDropCommand('--all')).toThrow(GitError);
  });
});
