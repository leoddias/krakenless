/**
 * The one place that knows where this project's version number is written.
 *
 * It is declared in five files, and keeping them in step by hand is how
 * v0.1.10-alpha shipped a `Cargo.lock` naming a dependency version that does
 * not exist: a search-and-replace for `version = "0.1.9"` matches
 * `cargo-platform` long before it matches `krakenless`. Nothing local notices,
 * because a warm registry cache never re-resolves; CI resolves from scratch and
 * dies on the first cargo command.
 *
 * So every edit here is anchored to a place, never to a value that happens to
 * be unique today, and every one of them asserts it matched exactly once.
 *
 * `Cargo.lock` is deliberately **not** written by this script. It is regenerated
 * with `cargo update -p krakenless`, which is the only tool that can also
 * confirm the result still resolves. This script reads it, so `check` can say
 * whether all five agree.
 *
 * Usage:
 *   node scripts/version.mjs read           print the current version
 *   node scripts/version.mjs check          exit 1 unless all five agree
 *   node scripts/version.mjs set <version>  write the four text files
 *   node scripts/version.mjs next <patch|minor|major>
 *   node scripts/version.mjs bump      read commit subjects on stdin, print the bump
 */

import { readFileSync, writeFileSync } from 'node:fs';

/** A release version: three numbers, no prerelease suffix. */
const VERSION = /^\d+\.\d+\.\d+$/;

/**
 * Replaces the single line matching `pattern`, refusing anything else.
 *
 * The count assertion is the point. A pattern that stops matching — because a
 * file was reformatted, or a key moved — must fail loudly here rather than
 * leave the version silently unchanged in one of five files.
 */
export function replaceOnce(text, pattern, replacement, what) {
  const matches = text.match(pattern);
  if (matches === null || matches.length !== 1) {
    throw new Error(
      `${what}: expected exactly one match for ${String(pattern)}, found ${matches?.length ?? 0}`,
    );
  }
  return text.replace(pattern, replacement);
}

/**
 * `package.json` and `tauri.conf.json`: the top-level `"version"` key.
 *
 * Anchored to a line beginning with exactly two spaces, which is what a
 * top-level key of a prettier-formatted object looks like. Anything nested is
 * indented further, so this cannot reach a dependency's version.
 */
export function setTopLevelJsonVersion(text, version, what) {
  return replaceOnce(
    text,
    /^ {2}"version": "[^"]*",?$/m,
    (line) => line.replace(/"version": "[^"]*"/, `"version": "${version}"`),
    what,
  );
}

export function readTopLevelJsonVersion(text) {
  return /^ {2}"version": "([^"]*)"/m.exec(text)?.[1] ?? null;
}

/**
 * `package-lock.json`: the root version, which npm writes twice.
 *
 * Parsed rather than pattern-matched, because the two places are identified by
 * their key path and not by their position, and re-serialised the way npm and
 * prettier both write it.
 */
export function setLockfileVersion(text, version) {
  const document = JSON.parse(text);
  if (
    typeof document.version !== 'string' ||
    typeof document.packages?.['']?.version !== 'string'
  ) {
    throw new Error('package-lock.json: no root version to set');
  }
  document.version = version;
  document.packages[''].version = version;
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function readLockfileVersion(text) {
  const document = JSON.parse(text);
  const root = document.version;
  const pkg = document.packages?.['']?.version;
  return root === pkg ? (root ?? null) : null;
}

/**
 * `Cargo.toml`: the `version` of the package itself.
 *
 * A dependency's version is always written inline (`foo = { version = "1" }`)
 * or after a key, never as a bare line starting the line, so anchoring to the
 * line start is enough to tell them apart.
 */
export function setCargoTomlVersion(text, version) {
  return replaceOnce(
    text,
    /^version = "[^"]*"$/m,
    `version = "${version}"`,
    'src-tauri/Cargo.toml',
  );
}

export function readCargoTomlVersion(text) {
  return /^version = "([^"]*)"$/m.exec(text)?.[1] ?? null;
}

/**
 * `Cargo.lock`: the version inside the `[[package]]` block for `name`.
 *
 * Read only. The block is found by its name field rather than by the first
 * version string that looks right — the distinction that the v0.1.10-alpha
 * failure was made of.
 */
export function readCargoLockVersion(text, name = 'krakenless') {
  for (const block of text.split(/\n\s*\n/)) {
    if (!block.includes('[[package]]')) continue;
    if (!new RegExp(`^name = "${name}"$`, 'm').test(block)) continue;
    return /^version = "([^"]*)"$/m.exec(block)?.[1] ?? null;
  }
  return null;
}

/**
 * The bump a set of commit subjects earns.
 *
 * Pre-1.0, so a breaking change is a minor rather than a major: the leading
 * zero is already the promise that anything may move. Everything that is not a
 * feature is a patch, including commits with no Conventional Commits prefix at
 * all — guessing lower is the safe direction, and a wrong patch number is
 * cheaper than a release that never happens because nobody typed the magic
 * word.
 */
export function decideBump(subjects) {
  let bump = 'patch';
  for (const subject of subjects) {
    if (/^[a-z]+(\([^)]*\))?!:/.test(subject) || /^BREAKING[ -]CHANGE/m.test(subject)) {
      return 'minor';
    }
    if (/^feat(\([^)]*\))?:/.test(subject)) bump = 'minor';
  }
  return bump;
}

export function nextVersion(current, bump) {
  if (!VERSION.test(current)) throw new Error(`not a release version: ${current}`);
  const [major, minor, patch] = current.split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Where each declaration lives, and how to read and write it. */
const FILES = [
  {
    path: 'package.json',
    read: readTopLevelJsonVersion,
    write: (text, v) => setTopLevelJsonVersion(text, v, 'package.json'),
  },
  { path: 'package-lock.json', read: readLockfileVersion, write: setLockfileVersion },
  {
    path: 'src-tauri/Cargo.toml',
    read: readCargoTomlVersion,
    write: setCargoTomlVersion,
  },
  {
    path: 'src-tauri/tauri.conf.json',
    read: readTopLevelJsonVersion,
    write: (text, v) => setTopLevelJsonVersion(text, v, 'src-tauri/tauri.conf.json'),
  },
  // Read-only here: `cargo update -p krakenless` owns it.
  { path: 'src-tauri/Cargo.lock', read: readCargoLockVersion, write: null },
];

function readAll() {
  return FILES.map((file) => ({
    path: file.path,
    version: file.read(readFileSync(file.path, 'utf8')),
  }));
}

function main(argv) {
  const [command, argument] = argv;

  if (command === 'read') {
    const found = readAll();
    const version = found[0].version;
    if (version === null) throw new Error('package.json declares no version');
    process.stdout.write(`${version}\n`);
    return 0;
  }

  if (command === 'check') {
    const found = readAll();
    const distinct = new Set(found.map((entry) => entry.version));
    if (distinct.size === 1 && !distinct.has(null)) {
      process.stdout.write(`all five declarations agree: ${found[0].version}\n`);
      return 0;
    }
    process.stderr.write('version declarations disagree:\n');
    for (const entry of found) {
      process.stderr.write(`  ${entry.path}: ${entry.version ?? '(unreadable)'}\n`);
    }
    process.stderr.write(
      'Fix with: node scripts/version.mjs set <version> && ' +
        'cargo update --manifest-path src-tauri/Cargo.toml -p krakenless\n',
    );
    return 1;
  }

  if (command === 'set') {
    if (!VERSION.test(argument ?? '')) {
      throw new Error(`set needs a version like 0.1.14, got ${argument ?? '(nothing)'}`);
    }
    for (const file of FILES) {
      if (file.write === null) continue;
      writeFileSync(file.path, file.write(readFileSync(file.path, 'utf8'), argument));
    }
    process.stdout.write(
      `set ${argument} in four files; now run ` +
        'cargo update --manifest-path src-tauri/Cargo.toml -p krakenless\n',
    );
    return 0;
  }

  if (command === 'bump') {
    const subjects = readFileSync(0, 'utf8').split('\n').filter(Boolean);
    process.stdout.write(`${decideBump(subjects)}\n`);
    return 0;
  }

  if (command === 'next') {
    const current = readAll()[0].version;
    if (current === null) throw new Error('package.json declares no version');
    process.stdout.write(`${nextVersion(current, argument ?? 'patch')}\n`);
    return 0;
  }

  process.stderr.write('usage: version.mjs read|check|set <v>|next <bump>|bump\n');
  return 2;
}

// Only when run, never when imported by the tests.
if (process.argv[1]?.endsWith('version.mjs')) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
