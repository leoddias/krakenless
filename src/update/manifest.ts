/**
 * The portable update manifest: what it looks like, and what makes one valid.
 *
 * `tauri-plugin-updater` fetches and parses its own manifest for installed
 * builds. The portable executable is not something that plugin can update — it
 * installs installers — so this project serves a second, separate file for it
 * and parses it here.
 *
 * Separate on purpose. Adding portable fields to the plugin's manifest would
 * make the portable path depend on the plugin's deserializer ignoring keys it
 * does not know, which is not a documented property of it.
 *
 * Everything in this module treats the manifest as hostile input. It arrives
 * over the network and decides which file the app is about to download and
 * swap itself for; the signature check in Rust is the thing that finally
 * authorises that, but a malformed manifest must resolve to "no update" long
 * before it gets there, never to an exception on a background timer.
 */

import { isNewer } from './version';

/** The only platform this manifest is read for while Windows is the target. */
export const PORTABLE_TARGET = 'windows-x86_64';

/**
 * Hosts a download may come from.
 *
 * The manifest lives on GitHub Pages and the binaries live on GitHub
 * Releases, so a compromise of the page cannot, on its own, point the app at
 * an arbitrary server. It is not the security boundary — the minisign
 * signature is — but it is a cheap second one, and it is the one that also
 * catches an honest mistake in the workflow that writes the file.
 */
const ALLOWED_HOSTS = ['github.com', 'objects.githubusercontent.com'];

export interface PortableRelease {
  /** Version being offered, as written in the manifest. */
  version: string;
  /** Direct download URL of the portable executable. */
  url: string;
  /** Detached minisign signature over the executable's bytes. */
  signature: string;
  /** Release notes, if the manifest carried any. */
  notes: string;
  /** Publication date as the manifest gave it, for display only. */
  pubDate: string;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True for an `https` URL on a host the binaries are actually published to.
 *
 * `http` is refused outright rather than upgraded: a manifest that names one
 * is a manifest something has gone wrong with.
 */
export function isAllowedDownloadUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  // `hostname`, not `host`: a port is not part of the identity being checked,
  // and comparing against `host` would let `github.com:8443` through only by
  // accident of formatting. Compared case-insensitively — a hostname is.
  return ALLOWED_HOSTS.includes(parsed.hostname.toLowerCase());
}

/**
 * Reads a manifest for `target`, returning the release it offers.
 *
 * `null` covers every reason there is nothing to offer: bad JSON, a shape
 * that is not a manifest, no entry for this platform, a missing or
 * unusable URL or signature. The caller cannot act differently on any of
 * them, and a background check has nobody to tell.
 */
export function parsePortableManifest(
  text: unknown,
  target: string = PORTABLE_TARGET,
): PortableRelease | null {
  if (typeof text !== 'string') return null;

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(document)) return null;

  const version = asString(document.version);
  if (version === null) return null;

  const platforms = document.platforms;
  if (!isObject(platforms)) return null;

  const platform = platforms[target];
  if (!isObject(platform)) return null;

  const url = asString(platform.url);
  const signature = asString(platform.signature);
  if (url === null || signature === null) return null;
  if (!isAllowedDownloadUrl(url)) return null;

  return {
    version,
    url,
    signature,
    notes: asString(document.notes) ?? '',
    pubDate: asString(document.pubDate) ?? '',
  };
}

/**
 * The release to offer the user, or `null` for "you are up to date".
 *
 * The version gate lives here rather than at the call site so that no caller
 * can forget it: this is the function that decides whether the app is about
 * to overwrite its own executable.
 */
export function releaseNewerThan(
  release: PortableRelease | null,
  currentVersion: string,
): PortableRelease | null {
  if (release === null) return null;
  return isNewer(release.version, currentVersion) ? release : null;
}
