import { describe, expect, it } from 'vitest';
import {
  LAYOUT_BOUNDS,
  MAX_RECENT_REPOS,
  clampLayout,
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

describe('remoteAvatars', () => {
  it('is off in a fresh config', () => {
    expect(defaultConfig().remoteAvatars).toBe(false);
  });

  it('is on only when the file says exactly true', () => {
    expect(parseConfig('{"remoteAvatars":true}').remoteAvatars).toBe(true);
  });

  it('reads anything else as off, because that is the private answer', () => {
    for (const value of ['"true"', '1', 'null', '"yes"', '{}']) {
      expect(parseConfig(`{"remoteAvatars":${value}}`).remoteAvatars).toBe(false);
    }
    expect(parseConfig('{}').remoteAvatars).toBe(false);
  });

  it('does not inherit the answer to the narrower question it replaced', () => {
    // `githubAvatars` (ADR-0019) fetched a picture by account number and
    // promised no email address was ever sent. `remoteAvatars` hashes the
    // address and sends it to Gravatar. Carrying the old `true` across would
    // answer a question the user was never asked (ADR-0021).
    expect(parseConfig('{"githubAvatars":true}').remoteAvatars).toBe(false);
    expect(
      parseConfig('{"githubAvatars":true,"remoteAvatars":false}').remoteAvatars,
    ).toBe(false);
  });

  it('writes only the new key, so the old one dies on the next save', () => {
    const config = parseConfig('{"githubAvatars":true,"remoteAvatars":true}');
    const text = serializeConfig(config);
    expect(text).toContain('"remoteAvatars": true');
    expect(text).not.toContain('githubAvatars');
  });
});

describe('autoFetchMinutes', () => {
  it('defaults to five minutes', () => {
    expect(defaultConfig().autoFetchMinutes).toBe(5);
    expect(parseConfig('{}').autoFetchMinutes).toBe(5);
  });

  it('keeps a value the user chose', () => {
    expect(parseConfig('{"autoFetchMinutes":15}').autoFetchMinutes).toBe(15);
  });

  it('treats zero and anything below it as off', () => {
    expect(parseConfig('{"autoFetchMinutes":0}').autoFetchMinutes).toBe(0);
    expect(parseConfig('{"autoFetchMinutes":-10}').autoFetchMinutes).toBe(0);
  });

  it('refuses an interval that would hammer the remote', () => {
    // A hand-edited fraction of a minute is a request loop against somebody's
    // server, so it is lifted to the floor rather than honoured.
    expect(parseConfig('{"autoFetchMinutes":0.05}').autoFetchMinutes).toBe(1);
    expect(parseConfig('{"autoFetchMinutes":1.4}').autoFetchMinutes).toBe(1);
    expect(parseConfig('{"autoFetchMinutes":99999}').autoFetchMinutes).toBe(1440);
  });

  it('falls back to the default for anything that is not a number', () => {
    expect(parseConfig('{"autoFetchMinutes":"5"}').autoFetchMinutes).toBe(5);
    expect(parseConfig('{"autoFetchMinutes":null}').autoFetchMinutes).toBe(5);
    expect(parseConfig('{"autoFetchMinutes":[]}').autoFetchMinutes).toBe(5);
  });
});

describe('layout', () => {
  it('has sizes that fit a 1280px window out of the box', () => {
    const { sidebarWidth, detailWidth, historyRatio } = defaultConfig().layout;
    expect(sidebarWidth + detailWidth).toBeLessThan(1280 / 2);
    expect(historyRatio).toBeGreaterThan(0.5);
  });

  it('reads sizes the user dragged', () => {
    expect(
      parseConfig('{"layout":{"sidebarWidth":320,"detailWidth":420,"historyRatio":0.4}}')
        .layout,
    ).toEqual({ sidebarWidth: 320, detailWidth: 420, historyRatio: 0.4 });
  });

  it('pulls a size from outside the bounds back inside them', () => {
    // A hand-edited config must not be able to leave a panel at zero width,
    // which is a layout the user cannot drag back.
    const tiny = parseConfig(
      '{"layout":{"sidebarWidth":0,"detailWidth":-40,"historyRatio":0}}',
    ).layout;
    expect(tiny.sidebarWidth).toBe(LAYOUT_BOUNDS.sidebarWidth.min);
    expect(tiny.detailWidth).toBe(LAYOUT_BOUNDS.detailWidth.min);
    expect(tiny.historyRatio).toBe(LAYOUT_BOUNDS.historyRatio.min);

    const huge = parseConfig(
      '{"layout":{"sidebarWidth":9000,"detailWidth":9000,"historyRatio":4}}',
    ).layout;
    expect(huge.sidebarWidth).toBe(LAYOUT_BOUNDS.sidebarWidth.max);
    expect(huge.detailWidth).toBe(LAYOUT_BOUNDS.detailWidth.max);
    expect(huge.historyRatio).toBe(LAYOUT_BOUNDS.historyRatio.max);
  });

  it('falls back to the default for anything that is not a real number', () => {
    const defaults = defaultConfig().layout;
    expect(parseConfig('{"layout":{"sidebarWidth":"320"}}').layout).toEqual(defaults);
    expect(parseConfig('{"layout":[]}').layout).toEqual(defaults);
    expect(parseConfig('{"layout":null}').layout).toEqual(defaults);
    expect(parseConfig('{}').layout).toEqual(defaults);
  });

  it('keeps the fields it can read when a neighbour is broken', () => {
    const layout = parseConfig(
      '{"layout":{"sidebarWidth":300,"detailWidth":"wide"}}',
    ).layout;
    expect(layout.sidebarWidth).toBe(300);
    expect(layout.detailWidth).toBe(defaultConfig().layout.detailWidth);
  });

  it('survives a round trip through the file', () => {
    const config = defaultConfig();
    config.layout = { sidebarWidth: 300, detailWidth: 400, historyRatio: 0.5 };
    expect(parseConfig(serializeConfig(config)).layout).toEqual(config.layout);
  });
});

describe('clampLayout', () => {
  it('is the same rule the file is read with, so the screen cannot disagree', () => {
    expect(
      clampLayout({ sidebarWidth: 1, detailWidth: 99999, historyRatio: -3 }),
    ).toEqual(
      parseConfig('{"layout":{"sidebarWidth":1,"detailWidth":99999,"historyRatio":-3}}')
        .layout,
    );
  });

  it('rejects a NaN that arithmetic on a bad measurement could produce', () => {
    const defaults = defaultConfig().layout;
    expect(clampLayout({ ...defaults, historyRatio: Number.NaN }).historyRatio).toBe(
      defaults.historyRatio,
    );
    // Infinity is not a size that was measured, so it is treated as no answer
    // at all rather than as "the widest allowed".
    expect(
      clampLayout({ ...defaults, sidebarWidth: Number.POSITIVE_INFINITY }).sidebarWidth,
    ).toBe(defaults.sidebarWidth);
  });
});
