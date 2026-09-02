/**
 * Deciding whether there is a newer Krakenless, and installing it.
 *
 * Two paths, one policy. An installed build is updated by
 * `tauri-plugin-updater`, which fetches its own manifest, verifies the
 * installer it downloads and runs it. A portable build has no installer to
 * run, so its manifest is fetched here and handed to `update_portable_apply`
 * in Rust, which verifies it against the same key before replacing the running
 * executable (ADR-0036).
 *
 * Everything below fails quiet. A check happens on a timer the user did not
 * start, against a machine that may be offline, behind a captive portal or on
 * a corporate proxy that returns a login page for every URL — none of which is
 * news, and all of which look like an error to code that reports errors. An
 * update the user *asks* for still says what went wrong.
 */

import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { check as checkInstalledUpdate } from '@tauri-apps/plugin-updater';

import { parsePortableManifest, releaseNewerThan } from './manifest';

/**
 * Where the portable manifest lives.
 *
 * A second file rather than more keys in the plugin's manifest: see
 * `manifest.ts`. It sits beside the plugin's on the project's GitHub Pages
 * site, written by the same workflow step, so the two cannot describe
 * different releases.
 */
export const PORTABLE_MANIFEST_URL =
  'https://leoddias.github.io/krakenless/updates/windows-x86_64-portable.json';

/** How this copy of Krakenless got onto the machine; mirrors the Rust enum. */
export type InstallKind = 'installed' | 'portable' | 'unknown';

export interface AvailableUpdate {
  kind: 'installed' | 'portable';
  /** The version being offered, for the notice. */
  version: string;
  /** Release notes as the manifest carried them; often empty. */
  notes: string;
  /**
   * Downloads and installs it.
   *
   * Does not return when it succeeds: both paths end with the process being
   * replaced. A caller must therefore treat "it returned" as an outcome worth
   * looking at, not as success.
   */
  apply: () => Promise<void>;
}

/** Asks Rust how this copy was installed. `unknown` on any failure. */
export async function installKind(): Promise<InstallKind> {
  try {
    return await invoke<InstallKind>('update_install_kind');
  } catch {
    return 'unknown';
  }
}

/** The running version, or `null` if it cannot be read. */
async function currentVersion(): Promise<string | null> {
  try {
    return await getVersion();
  } catch {
    return null;
  }
}

/**
 * Looks for an update to an installed build.
 *
 * The plugin does the version comparison, the download and the signature
 * check; this only turns its result into the shape the UI uses.
 */
async function checkInstalled(): Promise<AvailableUpdate | null> {
  const update = await checkInstalledUpdate();
  if (update === null) return null;
  return {
    kind: 'installed',
    version: update.version,
    notes: update.body ?? '',
    apply: () => update.downloadAndInstall(),
  };
}

/**
 * Looks for an update to a portable build.
 *
 * The response is read as text and validated by `parsePortableManifest`
 * rather than trusted as JSON of a known shape: this is the input that decides
 * which URL the app is about to download and swap itself for.
 */
async function checkPortable(version: string): Promise<AvailableUpdate | null> {
  // `no-store`: a cached manifest would keep announcing a version the user has
  // already installed, or keep hiding one that has just shipped.
  const response = await fetch(PORTABLE_MANIFEST_URL, { cache: 'no-store' });
  if (!response.ok) return null;

  const release = releaseNewerThan(parsePortableManifest(await response.text()), version);
  if (release === null) return null;

  return {
    kind: 'portable',
    version: release.version,
    notes: release.notes,
    apply: () =>
      invoke<void>('update_portable_apply', {
        url: release.url,
        signature: release.signature,
      }),
  };
}

/**
 * The update on offer, or `null` for "nothing to do".
 *
 * `null` also covers every failure. The caller is a background check with
 * nobody to tell; the manual check in Settings reports the *absence* of an
 * update, which is the honest thing to say either way — this function does not
 * know whether the network was down or the app is simply current, and neither
 * would change what the user does next.
 */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  try {
    const kind = await installKind();
    if (kind === 'unknown') return null;
    if (kind === 'installed') return await checkInstalled();

    const version = await currentVersion();
    if (version === null) return null;
    return await checkPortable(version);
  } catch {
    return null;
  }
}
