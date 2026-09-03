import { describe, expect, it } from 'vitest';
import {
  buildCherryPickCommand,
  buildMergeCommand,
  buildRebaseCommand,
  buildResetCommand,
  buildRevertCommand,
  buildTagCommand,
} from './history';
import { isDestructive } from '../destructive';
import { GitError } from '../errors';

const OID = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

describe('buildTagCommand', () => {
  it('names the tag and the commit it points at', () => {
    expect(buildTagCommand('v1.0', OID).args).toEqual(['tag', 'v1.0', OID]);
  });

  it('never forces, so a tag that already exists is refused rather than moved', () => {
    expect(buildTagCommand('v1.0', OID).args).not.toContain('--force');
    expect(buildTagCommand('v1.0', OID).args).not.toContain('-f');
  });

  it('annotates with the message before the name', () => {
    expect(buildTagCommand('v1.0', OID, { message: 'ship it' }).args).toEqual([
      'tag',
      '--annotate',
      '--message',
      'ship it',
      'v1.0',
      OID,
    ]);
  });

  it('refuses a blank annotation rather than letting git open an editor', () => {
    expect(() => buildTagCommand('v1.0', OID, { message: '   ' })).toThrow(
      'An annotated tag needs a message',
    );
  });

  it('passes a message that looks like a flag as a value, not an option', () => {
    const args = buildTagCommand('v1.0', OID, { message: '--delete' }).args;
    expect(args[args.indexOf('--message') + 1]).toBe('--delete');
  });

  it('rejects a tag name that would read as an option', () => {
    expect(() => buildTagCommand('--delete', OID)).toThrow(GitError);
  });

  it('rejects a revision that would read as an option', () => {
    expect(() => buildTagCommand('v1.0', '--delete')).toThrow(GitError);
  });

  it('creating a tag cannot lose work', () => {
    expect(isDestructive(buildTagCommand('v1.0', OID).args)).toBe(false);
  });
});

describe('buildCherryPickCommand', () => {
  it('names the commit to replay', () => {
    expect(buildCherryPickCommand(OID).args).toEqual(['cherry-pick', OID]);
  });

  it('is additive: it only ever writes a new commit', () => {
    expect(isDestructive(buildCherryPickCommand(OID).args)).toBe(false);
  });

  it('rejects a revision that would read as an option', () => {
    expect(() => buildCherryPickCommand('--abort')).toThrow(GitError);
  });
});

describe('buildRevertCommand', () => {
  it('supplies the message itself so no editor is spawned', () => {
    expect(buildRevertCommand(OID).args).toEqual(['revert', '--no-edit', OID]);
  });

  it('is additive: the undo is a new commit', () => {
    expect(isDestructive(buildRevertCommand(OID).args)).toBe(false);
  });

  it('rejects a revision that would read as an option', () => {
    expect(() => buildRevertCommand('--quit')).toThrow(GitError);
  });
});

describe('buildRebaseCommand', () => {
  it('replays the current branch onto the given commit', () => {
    // --autostash is not optional: without it git refuses over a dirty tree,
    // and the user is sent to a terminal to stash by hand.
    expect(buildRebaseCommand(OID).args).toEqual(['rebase', '--autostash', OID]);
  });

  it('is destructive both by flag and by argument inspection', () => {
    const command = buildRebaseCommand(OID);
    expect(command.destructive).toBe(true);
    expect(isDestructive(command.args)).toBe(true);
  });

  it('is never interactive — there is no terminal to host the editor', () => {
    const args = buildRebaseCommand(OID).args;
    expect(args).not.toContain('-i');
    expect(args).not.toContain('--interactive');
  });

  it('allows more than the default timeout', () => {
    expect(buildRebaseCommand(OID).timeoutMs).toBeGreaterThan(0);
  });

  it('rejects a revision that would read as an option', () => {
    expect(() => buildRebaseCommand('--abort')).toThrow(GitError);
  });
});

describe('buildResetCommand', () => {
  it.each(['soft', 'mixed', 'hard'] as const)('spells out the %s mode', (mode) => {
    expect(buildResetCommand(OID, mode).args).toEqual(['reset', `--${mode}`, OID]);
  });

  it.each(['soft', 'mixed', 'hard'] as const)(
    'requires confirmation for %s, not only for hard',
    (mode) => {
      expect(buildResetCommand(OID, mode).destructive).toBe(true);
    },
  );

  it('is recognized as destructive from the arguments when it is hard', () => {
    expect(isDestructive(buildResetCommand(OID, 'hard').args)).toBe(true);
  });

  it('rejects a revision that would read as an option', () => {
    expect(() => buildResetCommand('--hard', 'soft')).toThrow(GitError);
  });
});

describe('buildMergeCommand', () => {
  it('merges the revision without opening an editor', () => {
    // Without `--no-edit` a merge commit waits on an editor this process has
    // no terminal to host, and the command sits there until the timeout.
    expect(buildMergeCommand('feature/x').args).toEqual([
      'merge',
      '--no-edit',
      'feature/x',
    ]);
  });

  it('does not need a confirmation, because a merge only adds', () => {
    const command = buildMergeCommand('feature/x');
    expect(command.destructive).toBeUndefined();
    expect(isDestructive(command.args)).toBe(false);
  });

  it('gives a long merge room to finish', () => {
    expect(buildMergeCommand('feature/x').timeoutMs).toBe(120_000);
  });

  it('refuses a revision that could be read as an option', () => {
    expect(() => buildMergeCommand('--exec=rm -rf /')).toThrow();
  });
});
