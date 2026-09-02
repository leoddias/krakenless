import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
const getVersion = vi.fn();
const checkInstalledUpdate = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: checkInstalledUpdate }));

const { checkForUpdate, installKind, PORTABLE_MANIFEST_URL } = await import('./check');

const DOWNLOAD =
  'https://github.com/leoddias/krakenless/releases/download/v0.1.10-alpha/Krakenless_0.1.10_x64_portable.exe';

function portableManifest(version = '0.1.10'): string {
  return JSON.stringify({
    version,
    notes: 'Fixes the thing.',
    platforms: {
      'windows-x86_64': { url: DOWNLOAD, signature: 'c2ln' },
    },
  });
}

/** A `fetch` that answers the manifest URL and nothing else. */
function serve(body: string, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      expect(url).toBe(PORTABLE_MANIFEST_URL);
      return Promise.resolve({ ok, text: () => Promise.resolve(body) });
    }),
  );
}

beforeEach(() => {
  invoke.mockReset();
  getVersion.mockReset();
  checkInstalledUpdate.mockReset();
  getVersion.mockResolvedValue('0.1.9');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('installKind', () => {
  it('reports what Rust says', async () => {
    invoke.mockResolvedValue('portable');
    await expect(installKind()).resolves.toBe('portable');
  });

  it('is unknown when the command fails', async () => {
    invoke.mockRejectedValue(new Error('no'));
    await expect(installKind()).resolves.toBe('unknown');
  });
});

describe('checkForUpdate, installed', () => {
  beforeEach(() => {
    invoke.mockResolvedValue('installed');
  });

  it('offers what the plugin found', async () => {
    checkInstalledUpdate.mockResolvedValue({
      version: '0.1.10',
      body: 'Fixes the thing.',
      downloadAndInstall: vi.fn(),
    });

    const update = await checkForUpdate();

    expect(update).toMatchObject({
      kind: 'installed',
      version: '0.1.10',
      notes: 'Fixes the thing.',
    });
  });

  it('offers nothing when the plugin found nothing', async () => {
    checkInstalledUpdate.mockResolvedValue(null);
    await expect(checkForUpdate()).resolves.toBeNull();
  });

  it('applies through the plugin, not through the portable command', async () => {
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    checkInstalledUpdate.mockResolvedValue({
      version: '0.1.10',
      body: null,
      downloadAndInstall,
    });

    const update = await checkForUpdate();
    await update?.apply();

    expect(downloadAndInstall).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalledWith('update_portable_apply', expect.anything());
  });

  it('never fetches the portable manifest', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    checkInstalledUpdate.mockResolvedValue(null);

    await checkForUpdate();

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('checkForUpdate, portable', () => {
  beforeEach(() => {
    invoke.mockImplementation((command: string) =>
      command === 'update_install_kind' ? Promise.resolve('portable') : Promise.resolve(),
    );
  });

  it('offers a newer version from the manifest', async () => {
    serve(portableManifest());

    const update = await checkForUpdate();

    expect(update).toMatchObject({
      kind: 'portable',
      version: '0.1.10',
      notes: 'Fixes the thing.',
    });
  });

  it('hands the URL and signature to Rust, and nothing else', async () => {
    serve(portableManifest());

    const update = await checkForUpdate();
    await update?.apply();

    expect(invoke).toHaveBeenCalledWith('update_portable_apply', {
      url: DOWNLOAD,
      signature: 'c2ln',
    });
  });

  it('offers nothing when the manifest names the running version', async () => {
    serve(portableManifest('0.1.9'));
    await expect(checkForUpdate()).resolves.toBeNull();
  });

  it('offers nothing when the manifest names an older version', async () => {
    serve(portableManifest('0.1.8'));
    await expect(checkForUpdate()).resolves.toBeNull();
  });

  it('offers nothing when the manifest is not a manifest', async () => {
    serve('<html>login required</html>');
    await expect(checkForUpdate()).resolves.toBeNull();
  });

  it('offers nothing on a non-200 response', async () => {
    serve(portableManifest(), false);
    await expect(checkForUpdate()).resolves.toBeNull();
  });

  it('offers nothing when the network is unreachable, and does not throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(checkForUpdate()).resolves.toBeNull();
  });

  it('offers nothing when the running version cannot be read', async () => {
    getVersion.mockRejectedValue(new Error('no version'));
    serve(portableManifest());
    await expect(checkForUpdate()).resolves.toBeNull();
  });

  it('asks for the manifest without letting a cache answer', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(portableManifest()),
    });
    vi.stubGlobal('fetch', fetchSpy);

    await checkForUpdate();

    expect(fetchSpy).toHaveBeenCalledWith(PORTABLE_MANIFEST_URL, { cache: 'no-store' });
  });
});

describe('checkForUpdate, unknown install', () => {
  it('does nothing at all — no manifest, no plugin call', async () => {
    invoke.mockResolvedValue('unknown');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(checkForUpdate()).resolves.toBeNull();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(checkInstalledUpdate).not.toHaveBeenCalled();
  });
});
