/**
 * Fetching author pictures, once per identity, and keeping them on disk.
 *
 * The rule this module exists to enforce: an identity is requested from the
 * network **at most once**, and what comes back — a picture, or the answer
 * "there is no picture" — is written to `%APPDATA%/krakenless/avatars/` so
 * scrolling the graph never costs a request. Nothing here runs at all unless
 * the user turned `remoteAvatars` on (ADR-0021).
 *
 * The fetch happens here, in the webview, rather than in Rust: the Rust side
 * has no HTTP client and adding one is a much larger change than this feature
 * is worth. Rust stores and returns bytes; TypeScript decides what to ask for
 * and when, which is the same split as every other command in this app.
 */

import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import {
  avatarCacheKey,
  avatarIdentity,
  avatarSources,
  contentTypeForExtension,
  extensionForContentType,
  isCacheEntryFresh,
  MAX_AVATAR_BYTES,
  NO_PICTURE,
} from './remoteAvatar';

/**
 * How long one avatar request may take. Ten seconds is far longer than a few
 * kilobytes need and short enough that a host which accepts the connection and
 * then goes quiet does not stall every author behind it for the session.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** What Rust hands back for a cached identity. */
interface CacheEntry {
  /** Image extension, or `none` for "asked, and there is no picture". */
  extension: string;
  /** The stored bytes; empty for a negative entry. */
  bytes: number[];
  /** Unix milliseconds the entry was written. */
  storedAt: number;
}

/**
 * The answer for this session, per identity.
 *
 * Holds `null` both for "no picture" and for "the request failed", because for
 * the rest of the session they mean the same thing: do not ask again. Only the
 * first survives a restart — a failure writes nothing to disk, so being
 * offline once does not cost the user a picture forever.
 */
const memory = new Map<string, string | null>();
/** Requests in progress, so twenty rows by one author make one request. */
const inFlight = new Map<string, Promise<string | null>>();

/** For tests: forget everything this session learned. */
export function resetAvatarCache(): void {
  memory.clear();
  inFlight.clear();
}

/**
 * A data URL for the author's picture, or `null` when there is none.
 *
 * Never throws: a picture is decoration, and the derived badge underneath is
 * always there. Every failure path ends in `null`.
 */
export async function resolveAvatar(email: string, size: number): Promise<string | null> {
  const identity = avatarIdentity(email);
  if (identity === null) return null;

  const known = memory.get(identity);
  if (known !== undefined) return known;
  const pending = inFlight.get(identity);
  if (pending !== undefined) return pending;

  const request = resolve(identity, size).catch(() => null);
  inFlight.set(identity, request);
  const url = await request;
  inFlight.delete(identity);
  memory.set(identity, url);
  return url;
}

async function resolve(identity: string, size: number): Promise<string | null> {
  const key = await avatarCacheKey(identity);
  const entry = await readEntry(key);
  if (entry !== null && isCacheEntryFresh(entry.storedAt, Date.now())) {
    return entry.extension === NO_PICTURE ? null : dataUrl(entry.extension, entry.bytes);
  }
  return fetchAndCache(identity, key, size);
}

async function fetchAndCache(
  identity: string,
  key: string,
  size: number,
): Promise<string | null> {
  for (const url of avatarSources(identity, key, size)) {
    const picture = await fetchPicture(url);
    // A source that has no picture for this identity: try the next one.
    if (picture === 'absent') continue;
    // A failure — offline, blocked, refused. Cache nothing: the next launch
    // should be free to try again.
    if (picture === null) return null;
    await writeEntry(key, picture.extension, picture.bytes);
    return dataUrl(picture.extension, picture.bytes);
  }

  // Every source answered "no such identity". Remember that on disk, or every
  // scroll past this author would ask again.
  await writeEntry(key, NO_PICTURE, []);
  return null;
}

interface Picture {
  extension: string;
  bytes: number[];
}

/**
 * One request. `absent` means the host answered "no picture for this
 * identity" (404 — which is what `d=404` on the Gravatar URL buys us);
 * `null` means the request itself did not work.
 */
async function fetchPicture(url: string): Promise<Picture | 'absent' | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      // No cookies, no referrer: the request carries the URL and the IP and
      // nothing else about this machine or what it is looking at.
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      // Not followed. Following a redirect *makes* the onward request, and
      // that request would carry the identity's hash and this machine's IP to
      // a host the user never agreed to — checking afterwards would be too
      // late. Neither of the two hosts redirects this endpoint today; if one
      // starts, the picture is lost and the derived badge stays, which is the
      // right way for this to fail.
      redirect: 'error',
      // A host that accepts the connection and never answers would otherwise
      // park this promise forever, and with it every author after it.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return null;
  }

  // Belt and braces behind `redirect: 'error'`: whatever answered has to be
  // the host that was asked before a single byte of it is trusted, cached or
  // drawn.
  if (!sameHost(response.url, url)) return null;

  if (response.status === 404) return 'absent';
  if (!response.ok) return null;

  const extension = extensionForContentType(response.headers.get('content-type'));
  // A 200 that is not an image is a captive portal or a proxy, not a picture.
  // Storing it would make one bad answer permanent.
  if (extension === null) return null;
  // Refused before the body is read: an announced gigabyte must not be
  // buffered into the webview only to be rejected afterwards.
  if (declaredTooLarge(response.headers.get('content-length'))) return null;

  try {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_AVATAR_BYTES) return null;
    const bytes = [...new Uint8Array(buffer)];
    return { extension, bytes };
  } catch {
    return null;
  }
}

/**
 * Whether a response came back from the host that was asked.
 *
 * An empty `response.url` counts as same-host: with redirects refused outright
 * the only things that produce one are hand-built responses in tests, and the
 * request itself only ever went to a URL this module built.
 */
function sameHost(responseUrl: string, requestUrl: string): boolean {
  if (responseUrl === '') return true;
  try {
    return new URL(responseUrl).host === new URL(requestUrl).host;
  } catch {
    return false;
  }
}

/** True when the host announced a body too big to be an avatar. */
function declaredTooLarge(contentLength: string | null): boolean {
  if (contentLength === null) return false;
  const length = Number(contentLength);
  return Number.isFinite(length) && length > MAX_AVATAR_BYTES;
}

async function readEntry(key: string): Promise<CacheEntry | null> {
  try {
    return (await invoke<CacheEntry | null>('avatar_read', { key })) ?? null;
  } catch {
    // An unreadable cache is not a reason to fail; it is a reason to fetch.
    return null;
  }
}

async function writeEntry(
  key: string,
  extension: string,
  bytes: number[],
): Promise<void> {
  try {
    await invoke('avatar_write', { key, extension, bytes });
  } catch {
    // A cache that cannot be written costs a request next launch, nothing more.
  }
}

/** Bytes to a data URL, or `null` if the extension is not one we store. */
function dataUrl(extension: string, bytes: number[]): string | null {
  const contentType = contentTypeForExtension(extension);
  if (contentType === null || bytes.length === 0) return null;
  return `data:${contentType};base64,${base64(bytes)}`;
}

/**
 * Base64 of a byte array.
 *
 * Chunked because `String.fromCharCode(...bytes)` on a whole image passes tens
 * of thousands of arguments at once, which overflows the stack on exactly the
 * large pictures this is most needed for.
 */
function base64(bytes: number[]): string {
  const CHUNK = 0x8000;
  let text = '';
  for (let index = 0; index < bytes.length; index += CHUNK) {
    text += String.fromCharCode(...bytes.slice(index, index + CHUNK));
  }
  return btoa(text);
}

const NO_PICTURES: ReadonlyMap<string, string> = new Map();

/**
 * Pictures for the authors currently on screen, keyed by normalised identity.
 *
 * Resolves them one at a time rather than all at once: the list is what the
 * user can see, it changes on every scroll, and a burst of parallel requests
 * to one host is both rude and slower to show the first face. Everything
 * already known comes back from memory without touching disk or network.
 */
export function useAuthorPictures(
  emails: readonly string[],
  enabled: boolean,
  size: number,
): ReadonlyMap<string, string> {
  const [pictures, setPictures] = useState<ReadonlyMap<string, string>>(NO_PICTURES);
  // The dependency is the *content* of the list: it is rebuilt every render,
  // so depending on the array itself would restart the effect continuously.
  const joined = emails.join('\n');

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const run = async (): Promise<void> => {
      for (const email of joined === '' ? [] : joined.split('\n')) {
        const identity = avatarIdentity(email);
        if (identity === null) continue;
        const url = await resolveAvatar(email, size);
        if (cancelled) return;
        if (url === null) continue;
        setPictures((previous) => {
          if (previous.get(identity) === url) return previous;
          return new Map(previous).set(identity, url);
        });
      }
    };
    void run();

    return () => {
      cancelled = true;
    };
  }, [joined, enabled, size]);

  // Switched off is decided during render rather than by clearing the state:
  // nothing is drawn, and switching it back on shows what was already fetched
  // without a single new request.
  return enabled ? pictures : NO_PICTURES;
}
