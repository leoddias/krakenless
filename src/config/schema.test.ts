import { describe, expect, it } from 'vitest';
import {
  MAX_RECENT_REPOS,
  defaultConfig,
  parseConfig,
  serializeConfig,
  withRecentRepo,
  withoutRecentRepo,
} from './schema';

describe('parseConfig', () => {
  it('returns defaults when there is no file', () => {
    expect(parseConfig(null)).toEqual(defaultConfig());
  });

  it.each(['', '   ', 'not json', '[]', 'null', '42'])(
    'falls back to defaults for %j instead of throwing',
    (text) => {
      // A hand-edited config that got mangled must cost preferences, never the
      // ability to start the app.
      expect(parseConfig(text)).toEqual(defaultConfig());
    },
  );

  it('reads a complete file', () => {
    const config = parseConfig(
      JSON.stringify({
        version: 1,
        recentRepos: [{ path: 'C:/repos/app', lastOpened: '2026-08-19T10:00:00.000Z' }],
        editorCommand: 'code -g',
        mergetool: 'vscode',
        theme: 'light',
      }),
    );
    expect(config.recentRepos).toEqual([
      { path: 'C:/repos/app', lastOpened: '2026-08-19T10:00:00.000Z' },
    ]);
    expect(config.editorCommand).toBe('code -g');
    expect(config.theme).toBe('light');
  });

  it('drops junk entries rather than the whole list', () => {
    const config = parseConfig(
      JSON.stringify({
        recentRepos: [
          'a string',
          { path: '' },
          { nope: 1 },
          { path: 'C:/repos/good' },
          { path: 'C:/repos/good' },
        ],
      }),
    );
    expect(config.recentRepos).toEqual([
      { path: 'C:/repos/good', lastOpened: new Date(0).toISOString() },
    ]);
  });

  it('replaces an unknown theme with the default', () => {
    expect(parseConfig(JSON.stringify({ theme: 'neon' })).theme).toBe('dark');
  });

  it('caps a bloated recent list', () => {
    const recentRepos = Array.from({ length: 100 }, (_, i) => ({ path: `C:/r${i}` }));
    expect(parseConfig(JSON.stringify({ recentRepos })).recentRepos).toHaveLength(
      MAX_RECENT_REPOS,
    );
  });

  it('round-trips through serialization', () => {
    const config = withRecentRepo(
      defaultConfig(),
      'C:/repos/app',
      new Date('2026-08-19'),
    );
    expect(parseConfig(serializeConfig(config))).toEqual(config);
  });

  it('serializes readably, since users open this file', () => {
    const text = serializeConfig(defaultConfig());
    expect(text).toContain('\n  "version": 1');
    expect(text.endsWith('\n')).toBe(true);
  });
});

describe('withRecentRepo', () => {
  it('puts the newest first', () => {
    let config = defaultConfig();
    config = withRecentRepo(config, 'C:/a', new Date('2026-01-01'));
    config = withRecentRepo(config, 'C:/b', new Date('2026-01-02'));
    expect(config.recentRepos.map((r) => r.path)).toEqual(['C:/b', 'C:/a']);
  });

  it('moves an existing entry up instead of duplicating it', () => {
    let config = defaultConfig();
    config = withRecentRepo(config, 'C:/a', new Date('2026-01-01'));
    config = withRecentRepo(config, 'C:/b', new Date('2026-01-02'));
    config = withRecentRepo(config, 'C:/a', new Date('2026-01-03'));
    expect(config.recentRepos.map((r) => r.path)).toEqual(['C:/a', 'C:/b']);
    expect(config.recentRepos[0]?.lastOpened).toBe(new Date('2026-01-03').toISOString());
  });

  it('caps the list at the limit', () => {
    let config = defaultConfig();
    for (let i = 0; i <= MAX_RECENT_REPOS + 5; i += 1) {
      config = withRecentRepo(config, `C:/r${i}`, new Date(2026, 0, 1, 0, i));
    }
    expect(config.recentRepos).toHaveLength(MAX_RECENT_REPOS);
  });

  it('does not mutate the input', () => {
    const config = defaultConfig();
    withRecentRepo(config, 'C:/a', new Date());
    expect(config.recentRepos).toEqual([]);
  });
});

describe('withoutRecentRepo', () => {
  it('removes one entry and leaves the rest', () => {
    let config = defaultConfig();
    config = withRecentRepo(config, 'C:/a', new Date('2026-01-01'));
    config = withRecentRepo(config, 'C:/b', new Date('2026-01-02'));
    expect(withoutRecentRepo(config, 'C:/a').recentRepos.map((r) => r.path)).toEqual([
      'C:/b',
    ]);
  });

  it('is a no-op for an unknown path', () => {
    const config = withRecentRepo(defaultConfig(), 'C:/a', new Date());
    expect(withoutRecentRepo(config, 'C:/zzz').recentRepos).toHaveLength(1);
  });
});
