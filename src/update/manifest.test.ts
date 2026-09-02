import { describe, expect, it } from 'vitest';
import {
  isAllowedDownloadUrl,
  parsePortableManifest,
  PORTABLE_TARGET,
  releaseNewerThan,
} from './manifest';

const URL_0_1_10 =
  'https://github.com/leoddias/krakenless/releases/download/v0.1.10-alpha/Krakenless_0.1.10_x64_portable.exe';

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: '0.1.10',
    notes: 'Fixes the thing.',
    pubDate: '2026-09-02T10:00:00Z',
    platforms: {
      [PORTABLE_TARGET]: {
        url: URL_0_1_10,
        signature: 'untrusted comment: signature\nRWQf6…\n',
      },
    },
    ...overrides,
  });
}

describe('isAllowedDownloadUrl', () => {
  it.each([
    URL_0_1_10,
    'https://objects.githubusercontent.com/github-production-release-asset/1/2',
    'https://GitHub.com/leoddias/krakenless/releases/download/v1/a.exe',
  ])('allows %s', (url) => {
    expect(isAllowedDownloadUrl(url)).toBe(true);
  });

  it.each([
    ['http://github.com/a/b.exe', 'plain http'],
    ['https://github.com.evil.test/a/b.exe', 'a lookalike host'],
    ['https://evil.test/github.com/a.exe', 'the name in the path'],
    ['https://raw.githubusercontent.com/a/b.exe', 'a GitHub host we do not publish to'],
    ['file:///C:/Windows/System32/calc.exe', 'a local file'],
    ['not a url', 'junk'],
    ['', 'empty'],
  ])('refuses %s (%s)', (url) => {
    expect(isAllowedDownloadUrl(url)).toBe(false);
  });
});

describe('parsePortableManifest', () => {
  it('reads a well-formed manifest', () => {
    expect(parsePortableManifest(manifest())).toEqual({
      version: '0.1.10',
      url: URL_0_1_10,
      signature: 'untrusted comment: signature\nRWQf6…',
      notes: 'Fixes the thing.',
      pubDate: '2026-09-02T10:00:00Z',
    });
  });

  it('defaults the display-only fields rather than refusing', () => {
    const release = parsePortableManifest(
      JSON.stringify({
        version: '0.1.10',
        platforms: { [PORTABLE_TARGET]: { url: URL_0_1_10, signature: 'sig' } },
      }),
    );
    expect(release?.notes).toBe('');
    expect(release?.pubDate).toBe('');
  });

  it.each([
    ['not json at all', 'unparseable text'],
    ['[]', 'an array'],
    ['"0.1.10"', 'a bare string'],
    ['null', 'null'],
    ['{}', 'an empty object'],
  ])('returns null for %j (%s)', (text) => {
    expect(parsePortableManifest(text)).toBeNull();
  });

  it('returns null when this platform has no entry', () => {
    expect(
      parsePortableManifest(
        JSON.stringify({ version: '0.1.10', platforms: { 'darwin-aarch64': {} } }),
      ),
    ).toBeNull();
  });

  it.each([
    ['version', { version: '' }],
    ['platforms', { platforms: 'windows' }],
  ])('returns null when %s is unusable', (_field, overrides) => {
    expect(parsePortableManifest(manifest(overrides))).toBeNull();
  });

  it.each([
    ['url', { url: undefined }],
    ['signature', { signature: undefined }],
    ['url', { url: '   ' }],
  ])('returns null when the platform entry has no %s', (_field, patch) => {
    const text = JSON.stringify({
      version: '0.1.10',
      platforms: {
        [PORTABLE_TARGET]: { url: URL_0_1_10, signature: 'sig', ...patch },
      },
    });
    expect(parsePortableManifest(text)).toBeNull();
  });

  it('refuses a download URL pointing off GitHub, however valid the rest is', () => {
    const text = JSON.stringify({
      version: '99.0.0',
      platforms: {
        [PORTABLE_TARGET]: { url: 'https://evil.test/krakenless.exe', signature: 'sig' },
      },
    });
    expect(parsePortableManifest(text)).toBeNull();
  });

  it('returns null for a non-string input', () => {
    expect(parsePortableManifest(null)).toBeNull();
    expect(parsePortableManifest({ version: '9.9.9' })).toBeNull();
  });
});

describe('releaseNewerThan', () => {
  const release = parsePortableManifest(manifest());

  it('offers a newer release', () => {
    expect(releaseNewerThan(release, '0.1.9')?.version).toBe('0.1.10');
  });

  it('withholds the release the app is already running', () => {
    expect(releaseNewerThan(release, '0.1.10')).toBeNull();
  });

  it('withholds an older release', () => {
    expect(releaseNewerThan(release, '0.2.0')).toBeNull();
  });

  it('passes null through', () => {
    expect(releaseNewerThan(null, '0.1.9')).toBeNull();
  });
});
