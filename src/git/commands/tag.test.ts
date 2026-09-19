import { describe, expect, it } from 'vitest';
import { buildDeleteTagCommand, buildTagListCommand, TAG_FORMAT } from './tag';
import { buildDeleteRemoteTagCommand } from './remote';
import { isDestructive } from '../destructive';
import { GitError } from '../errors';

describe('buildTagListCommand', () => {
  it('reads every tag with both of its object ids', () => {
    const { args } = buildTagListCommand();
    expect(args).toContain('for-each-ref');
    expect(args).toContain('refs/tags');
    // The commit an annotated tag points into is the one the history has a row
    // for; without it the panel would select an oid nothing in the list shows.
    expect(TAG_FORMAT).toContain('%(objectname)');
    expect(TAG_FORMAT).toContain('%(*objectname)');
    expect(TAG_FORMAT).toContain('%(objecttype)');
  });

  it('separates the fields with NUL, which a ref name cannot contain', () => {
    expect(TAG_FORMAT).toContain('%00');
  });

  it('sorts by version, so v1.10 lands after v1.9 rather than before it', () => {
    expect(buildTagListCommand().args).toContain('--sort=-v:refname');
  });

  it('is read-only', () => {
    expect(isDestructive(buildTagListCommand().args)).toBe(false);
  });
});

describe('buildDeleteTagCommand', () => {
  it('deletes the named tag and nothing else', () => {
    expect(buildDeleteTagCommand('v1.0').args).toEqual(['tag', '--delete', 'v1.0']);
  });

  it('is destructive by its flag and by its arguments', () => {
    const command = buildDeleteTagCommand('v1.0');
    expect(command.destructive).toBe(true);
    expect(isDestructive(command.args)).toBe(true);
  });

  it('never carries a force flag: there is nothing here to force', () => {
    expect(buildDeleteTagCommand('v1.0').args).not.toContain('--force');
    expect(buildDeleteTagCommand('v1.0').args).not.toContain('-f');
  });

  it('refuses a name that would be read as an option', () => {
    expect(() => buildDeleteTagCommand('--all')).toThrow(GitError);
  });

  it('refuses a full ref path, which would delete something else or nothing', () => {
    expect(() => buildDeleteTagCommand('refs/tags/v1.0')).toThrow(GitError);
  });
});

describe('buildDeleteRemoteTagCommand', () => {
  it('names the ref in full, so a same-named branch cannot be hit instead', () => {
    expect(buildDeleteRemoteTagCommand('origin', 'release').args).toEqual([
      'push',
      '--progress',
      'origin',
      '--delete',
      'refs/tags/release',
    ]);
  });

  it('is destructive by its flag and by its arguments', () => {
    const command = buildDeleteRemoteTagCommand('origin', 'v1.0');
    expect(command.destructive).toBe(true);
    expect(isDestructive(command.args)).toBe(true);
  });

  it('gets the network budget rather than the sub-second default', () => {
    expect(buildDeleteRemoteTagCommand('origin', 'v1.0').timeoutMs).toBeGreaterThan(
      30_000,
    );
  });

  it('refuses an option-shaped remote or tag', () => {
    expect(() => buildDeleteRemoteTagCommand('--exec=rm', 'v1.0')).toThrow(GitError);
    expect(() => buildDeleteRemoteTagCommand('origin', '-v1.0')).toThrow(GitError);
  });

  it('refuses a tag name that is already a ref path', () => {
    // `refs/tags/refs/tags/v1` is a ref that exists nowhere, so the delete
    // would either fail or, worse, match something the user did not mean.
    expect(() => buildDeleteRemoteTagCommand('origin', 'refs/tags/v1.0')).toThrow(
      GitError,
    );
  });
});
