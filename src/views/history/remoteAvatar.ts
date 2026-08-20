/**
 * Where an author's picture can be fetched from, and under what key it is
 * cached. Pure: this module builds strings and never touches the network or
 * the disk — `avatarCache.ts` decides whether any of it is ever requested, and
 * only when the user turned `remoteAvatars` on (ADR-0021).
 *
 * Two sources, in this order:
 *
 * 1. `avatars.githubusercontent.com/u/<id>` for a
 *    `<id>+<login>@users.noreply.github.com` address. The number in that
 *    address *is* the account, so the picture is requested by id — no email,
 *    no hash of one, no token.
 * 2. Gravatar, for everybody else, as the SHA-256 of the lowercased address.
 *    This *does* tell Automattic that someone looked up that identity, which
 *    is why the whole feature is off until the user switches it on and the
 *    Settings copy says so in as many words.
 *
 * Anything that resolves to neither keeps the locally derived badge from
 * `avatar.ts`, which stays underneath a picture in any case.
 */

/**
 * Matches `<digits>+<login>@users.noreply.github.com` and captures the id.
 *
 * Anchored at both ends, and the host is matched literally rather than as a
 * suffix: `1+a@users.noreply.github.com.example.org` is a domain someone else
 * controls, and treating it as GitHub's would send a request there.
 */
const NOREPLY = /^([0-9]{1,12})\+[^@\s]+@users\.noreply\.github\.com$/i;

/** A cache key is exactly this: 64 lowercase hex digits of SHA-256. */
const CACHE_KEY = /^[0-9a-f]{64}$/;

/**
 * Loosely email-shaped: one `@`, something either side, no whitespace.
 *
 * Not a validator — git accepts almost anything in the author field. It is a
 * gate on what may become a network request, so a commit whose author line is
 * a name, a placeholder or a fragment of a broken import never causes one.
 */
const EMAIL_SHAPED = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * The form of an address that everything else keys on: trimmed, lowercased.
 *
 * Gravatar hashes the lowercased address, and git users write their own with
 * whatever capitalisation they feel like, so normalising here is what makes
 * `Ada@Example.com` and `ada@example.com` one cached identity instead of two
 * requests. Returns `null` when the value cannot be an address at all.
 */
export function avatarIdentity(email: string): string | null {
  const identity = email.trim().toLowerCase();
  return EMAIL_SHAPED.test(identity) ? identity : null;
}

/**
 * URL of the author's GitHub picture, or `null` when the address does not say
 * who they are on GitHub.
 *
 * @param size Requested edge length in pixels; GitHub serves a square.
 */
export function githubAvatarUrl(email: string, size: number): string | null {
  const match = NOREPLY.exec(email.trim());
  const id = match?.[1];
  if (id === undefined) return null;
  return `https://avatars.githubusercontent.com/u/${id}?s=${pixels(size)}&v=4`;
}

/**
 * URL of the Gravatar for an already-hashed identity, or `null` when the hash
 * is not one of ours.
 *
 * `d=404` is the load-bearing parameter: without it Gravatar invents a picture
 * for an identity it has never seen, and every author would get a generated
 * pattern instead of falling back to the badge that actually identifies them.
 *
 * The hash is required to be 64 hex digits before it is interpolated, so no
 * value derived from a commit can steer the path off the host — a malformed
 * one yields `null` rather than a request.
 */
export function gravatarUrl(hash: string, size: number): string | null {
  if (!CACHE_KEY.test(hash)) return null;
  return `https://www.gravatar.com/avatar/${hash}?s=${pixels(size)}&d=404`;
}

/**
 * Every URL worth trying for one identity, best first.
 *
 * A noreply address gets GitHub *and* Gravatar: the id resolves for anyone who
 * still has that account, and the Gravatar attempt only happens if GitHub says
 * 404 — an account that was deleted or renumbered. Both are tried once per
 * identity, ever: the result, picture or none, is written to the on-disk cache.
 *
 * The host of every URL here is a literal in a template. Nothing derived from
 * a commit ever becomes a host, which is what makes the set of places this app
 * can contact for a picture exactly two, whatever an author's email claims.
 */
export function avatarSources(identity: string, hash: string, size: number): string[] {
  const urls: string[] = [];
  const github = githubAvatarUrl(identity, size);
  if (github !== null) urls.push(github);
  const gravatar = gravatarUrl(hash, size);
  if (gravatar !== null) urls.push(gravatar);
  return urls;
}

/**
 * SHA-256 of a string, lowercase hex.
 *
 * `crypto.subtle` rather than a bundled hash: it is in every webview this app
 * runs in, and the alternative is a dependency doing arithmetic we would then
 * have to trust. Gravatar accepts SHA-256, so no MD5 implementation is needed
 * anywhere in this codebase.
 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** The disk-cache key for an identity: the same hash Gravatar is asked for. */
export async function avatarCacheKey(identity: string): Promise<string> {
  return sha256Hex(identity);
}

/** Image types worth caching, mapped to the extension they are stored under. */
const EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);

/** The extension a negative result is stored under: "asked, no picture". */
export const NO_PICTURE = 'none';

/**
 * Extension for a response's `Content-Type`, or `null` when the body is not an
 * image we are willing to keep.
 *
 * A host that answers an image request with HTML has not sent a picture, and
 * writing it to disk under an image extension and then handing it back as a
 * data URL is how a cache turns a bad response into a permanent one.
 */
export function extensionForContentType(contentType: string | null): string | null {
  if (contentType === null) return null;
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return EXTENSIONS.get(type) ?? null;
}

/** MIME type for a stored extension, for rebuilding the data URL on read. */
export function contentTypeForExtension(extension: string): string | null {
  for (const [type, ext] of EXTENSIONS) {
    if (ext === extension) return type;
  }
  return null;
}

/**
 * How long a cached answer stands, in milliseconds.
 *
 * Thirty days, for pictures and for "no picture" alike. One number rather than
 * two because the expiry is not about correctness — a face that is a month out
 * of date is not a bug — it is about how often this app is allowed to touch the
 * network for something purely decorative. Thirty days caps that at one request
 * per author per month, while still letting somebody who signs up for Gravatar
 * today appear without deleting anything by hand.
 */
export const AVATAR_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Most bytes a picture may be. A 32-pixel avatar is single-digit kilobytes;
 * this is the point past which a response is not an avatar but a way to spend
 * the user's memory and disk. The Rust side refuses the same size, so neither
 * half of the round trip depends on the other having checked.
 */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/** Whether a cache entry written at `storedAt` may still be used at `now`. */
export function isCacheEntryFresh(storedAt: number, now: number): boolean {
  if (!Number.isFinite(storedAt)) return false;
  // A timestamp in the future means a clock that moved; treat it as stale
  // rather than as valid until the year it claims.
  if (storedAt > now) return false;
  return now - storedAt < AVATAR_CACHE_TTL_MS;
}

/**
 * A size that can safely be interpolated into a URL. `Math.round(NaN)` is
 * `NaN`, which would ask a host for `?s=NaN`, so a value that is not a finite
 * number falls back to the badge's own size rather than travelling.
 */
function pixels(size: number): string {
  if (!Number.isFinite(size)) return '32';
  return String(Math.max(1, Math.min(512, Math.round(size))));
}
