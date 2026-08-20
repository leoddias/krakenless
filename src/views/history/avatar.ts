/**
 * Author avatars, computed locally.
 *
 * Git stores a name and an email in a commit and nothing else — there is no
 * picture in the repository. This module makes one up rather than asking
 * anybody: initials on a colour picked deterministically from the identity.
 * Same author, same badge, in every repository, forever, and nothing leaves
 * the machine.
 *
 * This is what the graph draws by default. A user who switches `remoteAvatars`
 * on (ADR-0021) gets a fetched picture layered *over* this badge, never
 * instead of it, so a request that is blocked, offline or 404 still leaves a
 * face rather than a hole.
 */

/**
 * Up to two initials for an author name.
 *
 * Iterated by code point rather than by UTF-16 unit: a name beginning with an
 * emoji or an astral-plane character would otherwise yield half a surrogate
 * pair, which renders as a replacement glyph.
 */
export function initials(name: string): string {
  const words = name
    .split(/[\s._-]+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);

  const first = words[0];
  if (first === undefined) return '?';

  const last = words.length > 1 ? words[words.length - 1] : undefined;
  const head = firstCodePoint(first);
  if (last === undefined) return head.toUpperCase();
  return (head + firstCodePoint(last)).toUpperCase();
}

function firstCodePoint(word: string): string {
  return [...word][0] ?? '';
}

/**
 * A stable hue for an identity, in degrees.
 *
 * FNV-1a over the code units: small, dependency-free, and well spread for the
 * short strings an email address is. The email is preferred over the name
 * because it is the identity git actually keys on — two people called "Alex"
 * get different colours, and one person committing under two spellings of their
 * name keeps one.
 */
export function avatarHue(email: string, name: string): number {
  const identity = (email.trim() === '' ? name : email).trim().toLowerCase();
  let hash = 0x811c9dc5;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    // FNV prime, applied with shifts so the result stays inside 32 bits.
    hash =
      (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash % 360;
}

/** Background colour of the badge: dark enough for white initials on top. */
export function avatarFill(email: string, name: string): string {
  return `hsl(${avatarHue(email, name)} 42% 38%)`;
}
