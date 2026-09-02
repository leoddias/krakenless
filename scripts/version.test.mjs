import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decideBump,
  nextVersion,
  readCargoLockVersion,
  readCargoTomlVersion,
  readLockfileVersion,
  readTopLevelJsonVersion,
  replaceOnce,
  setCargoTomlVersion,
  setLockfileVersion,
  setTopLevelJsonVersion,
} from './version.mjs';

describe('replaceOnce', () => {
  it('refuses a pattern that matches nothing', () => {
    expect(() => replaceOnce('abc', /^z$/m, 'y', 'thing')).toThrow(/found 0/);
  });

  it('refuses a pattern that matches twice, rather than editing the first', () => {
    expect(() => replaceOnce('a\na\n', /^a$/gm, 'b', 'thing')).toThrow(/found 2/);
  });
});

describe('top-level JSON version', () => {
  const json = [
    '{',
    '  "name": "krakenless",',
    '  "version": "0.1.13",',
    '  "x": 1',
    '}',
  ].join('\n');

  it('reads it', () => {
    expect(readTopLevelJsonVersion(json)).toBe('0.1.13');
  });

  it('writes it', () => {
    expect(setTopLevelJsonVersion(json, '0.1.14', 'test')).toContain(
      '"version": "0.1.14"',
    );
  });

  it('leaves a nested version alone — a dependency is not the app', () => {
    const nested = [
      '{',
      '  "version": "0.1.13",',
      '  "packages": {',
      '    "node_modules/x": {',
      '      "version": "0.1.13"',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const result = setTopLevelJsonVersion(nested, '9.9.9', 'test');

    expect(result).toContain('  "version": "9.9.9",');
    expect(result).toContain('      "version": "0.1.13"');
  });

  it('refuses a file whose top-level version is not where it expects', () => {
    expect(() =>
      setTopLevelJsonVersion('{"version":"0.1.13"}', '0.1.14', 'test'),
    ).toThrow(/exactly one match/);
  });
});

describe('package-lock version', () => {
  const lock = JSON.stringify(
    {
      name: 'krakenless',
      version: '0.1.13',
      packages: {
        '': { name: 'krakenless', version: '0.1.13' },
        'node_modules/x': { version: '1.0.0' },
      },
    },
    null,
    2,
  );

  it('reads the root version when both copies agree', () => {
    expect(readLockfileVersion(lock)).toBe('0.1.13');
  });

  it('reads null when the two copies disagree, which is a broken lockfile', () => {
    const broken = JSON.parse(lock);
    broken.packages[''].version = '0.1.12';
    expect(readLockfileVersion(JSON.stringify(broken))).toBeNull();
  });

  it('writes both copies and nothing else', () => {
    const result = JSON.parse(setLockfileVersion(lock, '0.1.14'));
    expect(result.version).toBe('0.1.14');
    expect(result.packages[''].version).toBe('0.1.14');
    expect(result.packages['node_modules/x'].version).toBe('1.0.0');
  });

  it('ends with a newline, the way npm and prettier both write it', () => {
    expect(setLockfileVersion(lock, '0.1.14').endsWith('}\n')).toBe(true);
  });
});

describe('Cargo.toml version', () => {
  const toml = [
    '[package]',
    'name = "krakenless"',
    'version = "0.1.13"',
    '',
    '[dependencies]',
    'serde = { version = "1.0", features = ["derive"] }',
    'log = "0.4"',
  ].join('\n');

  it('reads the package version', () => {
    expect(readCargoTomlVersion(toml)).toBe('0.1.13');
  });

  it('writes it without touching an inline dependency version', () => {
    const result = setCargoTomlVersion(toml, '0.1.14');
    expect(result).toContain('version = "0.1.14"');
    expect(result).toContain('serde = { version = "1.0"');
  });
});

describe('Cargo.lock version', () => {
  // The shape that mattered: `cargo-platform` sorts before `krakenless` and
  // once carried the same version string. Picking the first match rewrote the
  // wrong package and shipped a lockfile that would not resolve.
  const lock = [
    '[[package]]',
    'name = "cargo-platform"',
    'version = "0.1.9"',
    'source = "registry+https://github.com/rust-lang/crates.io-index"',
    '',
    '[[package]]',
    'name = "krakenless"',
    'version = "0.1.13"',
    'dependencies = [',
    ' "log",',
    ']',
    '',
    '[[package]]',
    'name = "log"',
    'version = "0.4.28"',
  ].join('\n');

  it('reads the version of the package it was asked about, not the first one', () => {
    expect(readCargoLockVersion(lock, 'krakenless')).toBe('0.1.13');
    expect(readCargoLockVersion(lock, 'cargo-platform')).toBe('0.1.9');
  });

  it('reads null for a package that is not there', () => {
    expect(readCargoLockVersion(lock, 'nothing')).toBeNull();
  });

  it('is not fooled by a package whose name contains the one asked for', () => {
    const similar = [
      '[[package]]',
      'name = "krakenless-extra"',
      'version = "9.9.9"',
    ].join('\n');
    expect(readCargoLockVersion(similar, 'krakenless')).toBeNull();
  });
});

describe('decideBump', () => {
  it('is a patch for fixes, docs and chores', () => {
    expect(decideBump(['fix: a thing', 'docs: words', 'chore: tidy'])).toBe('patch');
  });

  it('is a minor when anything is a feature', () => {
    expect(decideBump(['fix: a thing', 'feat(updater): a dialog'])).toBe('minor');
  });

  it('is a minor for a breaking change, because pre-1.0 has no major to give', () => {
    expect(decideBump(['fix!: removed a flag'])).toBe('minor');
    expect(decideBump(['refactor(git)!: renamed'])).toBe('minor');
  });

  it('is a patch for subjects with no Conventional Commits prefix at all', () => {
    expect(decideBump(['tidy up', 'WIP'])).toBe('patch');
  });

  it('is a patch for nothing at all', () => {
    expect(decideBump([])).toBe('patch');
  });

  it('does not read "feature" or "featured" as feat', () => {
    expect(decideBump(['featured: nope', 'feature: nope'])).toBe('patch');
  });
});

describe('nextVersion', () => {
  it.each([
    ['0.1.13', 'patch', '0.1.14'],
    ['0.1.13', 'minor', '0.2.0'],
    ['0.1.13', 'major', '1.0.0'],
    ['0.1.9', 'patch', '0.1.10'],
  ])('%s + %s = %s', (current, bump, expected) => {
    expect(nextVersion(current, bump)).toBe(expected);
  });

  it('refuses a version it cannot read', () => {
    expect(() => nextVersion('v0.1.13-alpha', 'patch')).toThrow(/not a release version/);
  });
});

describe('the repository itself', () => {
  it('declares one version in all five places', () => {
    const found = [
      readTopLevelJsonVersion(readFileSync('package.json', 'utf8')),
      readLockfileVersion(readFileSync('package-lock.json', 'utf8')),
      readCargoTomlVersion(readFileSync('src-tauri/Cargo.toml', 'utf8')),
      readTopLevelJsonVersion(readFileSync('src-tauri/tauri.conf.json', 'utf8')),
      readCargoLockVersion(readFileSync('src-tauri/Cargo.lock', 'utf8')),
    ];
    expect(new Set(found).size).toBe(1);
    expect(found[0]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
