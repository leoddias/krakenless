/**
 * Version comparison for the updater.
 *
 * The app's own version is a plain `major.minor.patch`; the versions it is
 * offered come from a file on the internet and may carry a prerelease suffix
 * (`0.2.0-alpha`, `0.2.0-rc.2`) because every release so far has been one.
 *
 * This is the gate that decides whether the app will replace its own
 * executable, so it fails closed: anything it cannot parse compares as "not
 * newer", and an update is offered only on a strict `>`. A manifest that has
 * been rolled back, hand-edited, or served stale can therefore never talk the
 * app into installing an older build over a newer one.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /**
   * Dot-separated prerelease identifiers, empty for a final release.
   *
   * Kept as the raw identifiers rather than a single string: `alpha.2` and
   * `alpha.10` order the wrong way round as text, and that comparison decides
   * whether a user is offered a downgrade.
   */
  prerelease: string[];
}

/** `0.1.10`, `v0.1.10`, `0.2.0-alpha`, `0.2.0-rc.2`. Build metadata is ignored. */
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parses a version, or `null` if it is not one. Never throws. */
export function parseVersion(text: unknown): ParsedVersion | null {
  if (typeof text !== 'string') return null;
  const match = VERSION.exec(text.trim());
  if (match === null) return null;

  const [, major, minor, patch, prerelease] = match;
  // An empty identifier — `1.0.0-` or `1.0.0-a..b` — is not a version. The
  // regex allows the dots; this rejects what they can spell.
  const identifiers = prerelease === undefined ? [] : prerelease.split('.');
  if (identifiers.some((identifier) => identifier === '')) return null;

  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: identifiers,
  };
}

/** True for an identifier made only of digits, which compares numerically. */
function isNumeric(identifier: string): boolean {
  return /^\d+$/.test(identifier);
}

/** Compares two prerelease identifier lists by the semver rules. */
function comparePrerelease(a: string[], b: string[]): number {
  // A release outranks any prerelease of the same numbers: `1.0.0` > `1.0.0-rc`.
  // The empty list means "no prerelease", so it is the *larger* one here — the
  // opposite of how an empty list usually sorts, and the reason this is not a
  // plain lexicographic compare.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    // `?? ''` only satisfies the index checker: the loop stops at the shorter
    // list, so neither side can actually be missing here.
    const left = a[index] ?? '';
    const right = b[index] ?? '';
    if (left === right) continue;

    const leftNumeric = isNumeric(left);
    const rightNumeric = isNumeric(right);
    if (leftNumeric && rightNumeric) return Number(left) < Number(right) ? -1 : 1;
    // Numeric identifiers always rank below alphanumeric ones.
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return left < right ? -1 : 1;
  }

  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/** `-1`, `0` or `1`, ordering `a` against `b`. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * True when `offered` is a strictly newer version than `current`.
 *
 * Both must parse. An unparseable offer is not an update, and an unparseable
 * *current* version is the more dangerous half: it would otherwise make every
 * offer look newer, so it refuses too.
 */
export function isNewer(offered: unknown, current: unknown): boolean {
  const next = parseVersion(offered);
  const now = parseVersion(current);
  if (next === null || now === null) return false;
  return compareVersions(next, now) > 0;
}
