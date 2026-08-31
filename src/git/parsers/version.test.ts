import { describe, expect, it } from 'vitest';
import {
  formatVersion,
  isAtLeast,
  MINIMUM_GIT,
  parseGitVersion,
  unsupportedGitMessage,
} from './version';

describe('parseGitVersion', () => {
  it('reads a plain version', () => {
    expect(parseGitVersion('git version 2.43.0\n')).toMatchObject({
      major: 2,
      minor: 43,
      patch: 0,
    });
  });

  it.each([
    ['Windows', 'git version 2.29.2.windows.1', [2, 29, 2]],
    ['Apple', 'git version 2.39.5 (Apple Git-154)', [2, 39, 5]],
    ['Debian', 'git version 2.30.2 (Debian 1:2.30.2-1)', [2, 30, 2]],
    ['a release candidate', 'git version 2.40.0.rc2', [2, 40, 0]],
    ['a two-part version', 'git version 2.30', [2, 30, 0]],
  ])('reads the %s build string', (_name, line, expected) => {
    // Distributions decorate this line freely; the numbers are the only part
    // that is actually specified.
    const version = parseGitVersion(line);
    expect([version?.major, version?.minor, version?.patch]).toEqual(expected);
  });

  it('keeps the line verbatim, so the message can quote what git said', () => {
    expect(parseGitVersion('git version 2.29.2.windows.1')?.raw).toBe(
      'git version 2.29.2.windows.1',
    );
  });

  it.each([
    ['empty output', ''],
    ['a wrapper printing something else', 'my-git-wrapper v3\n'],
    ['a missing number', 'git version next\n'],
  ])('returns null for %s rather than throwing', (_name, output) => {
    expect(parseGitVersion(output)).toBeNull();
  });
});

describe('isAtLeast', () => {
  it('compares field by field, not as a decimal', () => {
    // The bug this prevents: 2.9 > 2.23 when the version is read as a number.
    expect(isAtLeast({ major: 2, minor: 9, patch: 0 }, MINIMUM_GIT)).toBe(false);
    expect(isAtLeast({ major: 2, minor: 23, patch: 0 }, MINIMUM_GIT)).toBe(true);
  });

  it('accepts the minimum exactly', () => {
    expect(isAtLeast(MINIMUM_GIT, MINIMUM_GIT)).toBe(true);
  });

  it('lets a newer major win regardless of the minor', () => {
    expect(isAtLeast({ major: 3, minor: 0, patch: 0 }, MINIMUM_GIT)).toBe(true);
    expect(isAtLeast({ major: 1, minor: 99, patch: 0 }, MINIMUM_GIT)).toBe(false);
  });

  it('compares the patch when major and minor match', () => {
    const min = { major: 2, minor: 23, patch: 4 };
    expect(isAtLeast({ major: 2, minor: 23, patch: 3 }, min)).toBe(false);
    expect(isAtLeast({ major: 2, minor: 23, patch: 4 }, min)).toBe(true);
  });
});

describe('unsupportedGitMessage', () => {
  it('names the version found, the version needed, and what to do', () => {
    // The whole point: the flag-level failures could say none of these.
    const message = unsupportedGitMessage(parseGitVersion('git version 2.20.1'));
    expect(message).toContain('2.20.1');
    expect(message).toContain('2.23.0');
    expect(message).toMatch(/update git/i);
  });

  it('is silent for a supported git', () => {
    expect(unsupportedGitMessage(parseGitVersion('git version 2.39.2'))).toBeNull();
    expect(unsupportedGitMessage(parseGitVersion('git version 2.23.0'))).toBeNull();
  });

  it('does not refuse the versions the recent flag bugs happened on', () => {
    // Worth stating outright: git 2.29-2.30 is *supported*. This check would
    // not have caught the `--path-format` or `--diff-merges` failures — those
    // were the app using flags newer than its own floor, and the fix was to
    // stop using them. The floor only refuses a git older than the commands.
    expect(unsupportedGitMessage(parseGitVersion('git version 2.29.2'))).toBeNull();
    expect(unsupportedGitMessage(parseGitVersion('git version 2.30.2'))).toBeNull();
  });

  it('is silent when the version could not be read', () => {
    // An unfamiliar version string is not evidence of an old git, and refusing
    // to open on one would break a working install to avoid a worse message.
    expect(unsupportedGitMessage(null)).toBeNull();
  });
});

describe('the declared minimum', () => {
  it('is the version that added the newest command the app uses', () => {
    // `git restore` and `git switch` both landed in 2.23; every other flag in
    // the git layer predates it. Raising this without a code change would
    // refuse installs that work.
    expect(formatVersion(MINIMUM_GIT)).toBe('2.23.0');
  });
});
