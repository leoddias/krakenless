import { describe, expect, it } from 'vitest';
import { compareVersions, isNewer, parseVersion } from './version';

describe('parseVersion', () => {
  it('reads a plain release', () => {
    expect(parseVersion('0.1.9')).toEqual({
      major: 0,
      minor: 1,
      patch: 9,
      prerelease: [],
    });
  });

  it('accepts the tag form the releases are named with', () => {
    expect(parseVersion('v0.1.9-alpha')).toEqual({
      major: 0,
      minor: 1,
      patch: 9,
      prerelease: ['alpha'],
    });
  });

  it('splits dotted prerelease identifiers', () => {
    expect(parseVersion('1.0.0-rc.2')?.prerelease).toEqual(['rc', '2']);
  });

  it('ignores build metadata', () => {
    expect(parseVersion('1.2.3+build.5')?.prerelease).toEqual([]);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseVersion('  0.1.9\n')?.patch).toBe(9);
  });

  it.each([
    ['', 'empty'],
    ['1.2', 'two components'],
    ['1.2.3.4', 'four components'],
    ['1.2.x', 'non-numeric patch'],
    ['1.2.3-', 'empty prerelease'],
    ['1.2.3-a..b', 'empty identifier'],
    ['latest', 'a word'],
    ['0.1.9 || rm -rf', 'trailing junk'],
  ])('rejects %j (%s)', (text) => {
    expect(parseVersion(text)).toBeNull();
  });

  it.each([null, undefined, 42, {}, ['1.0.0']])('rejects the non-string %j', (value) => {
    expect(parseVersion(value)).toBeNull();
  });
});

describe('compareVersions', () => {
  const parse = (text: string) => {
    const version = parseVersion(text);
    if (version === null) throw new Error(`not a version: ${text}`);
    return version;
  };

  it.each([
    ['0.1.9', '0.1.10', -1],
    ['0.1.10', '0.1.9', 1],
    ['0.2.0', '0.10.0', -1],
    ['1.0.0', '0.99.99', 1],
    ['0.1.9', '0.1.9', 0],
  ])('orders %s against %s', (a, b, expected) => {
    expect(compareVersions(parse(a), parse(b))).toBe(expected);
  });

  it('ranks a release above its own prerelease', () => {
    expect(compareVersions(parse('1.0.0'), parse('1.0.0-alpha'))).toBe(1);
    expect(compareVersions(parse('1.0.0-alpha'), parse('1.0.0'))).toBe(-1);
  });

  it('orders numeric prerelease identifiers as numbers, not text', () => {
    expect(compareVersions(parse('1.0.0-alpha.2'), parse('1.0.0-alpha.10'))).toBe(-1);
  });

  it('ranks a numeric identifier below an alphanumeric one', () => {
    expect(compareVersions(parse('1.0.0-1'), parse('1.0.0-alpha'))).toBe(-1);
  });

  it('ranks a longer identifier list above its own prefix', () => {
    expect(compareVersions(parse('1.0.0-alpha'), parse('1.0.0-alpha.1'))).toBe(-1);
  });

  it('walks the semver specification example in order', () => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];
    ordered.forEach((later, index) => {
      if (index === 0) return;
      const earlier = ordered[index - 1] ?? '';
      expect(compareVersions(parse(earlier), parse(later))).toBe(-1);
    });
  });
});

describe('isNewer', () => {
  it('offers a higher version', () => {
    expect(isNewer('0.1.10', '0.1.9')).toBe(true);
  });

  it('does not offer the same version', () => {
    expect(isNewer('0.1.9', '0.1.9')).toBe(false);
  });

  it('never offers a downgrade', () => {
    expect(isNewer('0.1.8', '0.1.9')).toBe(false);
    expect(isNewer('0.1.9-alpha', '0.1.9')).toBe(false);
  });

  it('refuses an offer it cannot parse', () => {
    expect(isNewer('newest', '0.1.9')).toBe(false);
  });

  it('refuses when the current version is unreadable, rather than accepting everything', () => {
    expect(isNewer('99.0.0', 'unknown')).toBe(false);
  });
});
