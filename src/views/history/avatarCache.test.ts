import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAvatarCache, resolveAvatar } from './avatarCache';
import { AVATAR_CACHE_TTL_MS, MAX_AVATAR_BYTES } from './remoteAvatar';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

/** SHA-256 of `ada@example.com`. */
const ADA = 'b5fc85e55755f9e0d030a10ab4429b6b2944855f9a0d60077fe832becbc41d72';
const GRAVATAR = `https://www.gravatar.com/avatar/${ADA}?s=32&d=404`;

interface CacheEntry {
  extension: string;
  bytes: number[];
  storedAt: number;
}

/** The disk cache, as a map, so a test can see exactly what was written. */
function fakeDisk(initial: Record<string, CacheEntry> = {}): Map<string, CacheEntry> {
  const disk = new Map(Object.entries(initial));
  invoke.mockImplementation((command: string, args: Record<string, unknown>) => {
    const key = args['key'] as string;
    if (command === 'avatar_read') return Promise.resolve(disk.get(key) ?? null);
    if (command === 'avatar_write') {
      disk.set(key, {
        extension: args['extension'] as string,
        bytes: args['bytes'] as number[],
        storedAt: Date.now(),
      });
      return Promise.resolve(null);
    }
    throw new Error(`unexpected command ${command}`);
  });
  return disk;
}

function imageResponse(bytes: number[], type = 'image/png'): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': type },
  });
}

function notFound(): Response {
  return new Response(null, { status: 404 });
}

function fetchMock(): ReturnType<typeof vi.fn> {
  const mock = vi.fn();
  vi.stubGlobal('fetch', mock);
  return mock;
}

beforeEach(() => {
  resetAvatarCache();
  invoke.mockReset();
  vi.unstubAllGlobals();
});

describe('resolveAvatar', () => {
  it('fetches an ordinary address from Gravatar and caches the bytes', async () => {
    const disk = fakeDisk();
    const fetched = fetchMock().mockResolvedValue(imageResponse([1, 2, 3]));

    const url = await resolveAvatar('Ada@Example.com', 32);

    expect(fetched).toHaveBeenCalledTimes(1);
    expect(fetched.mock.calls[0]?.[0]).toBe(GRAVATAR);
    expect(url).toBe('data:image/png;base64,AQID');
    expect(disk.get(ADA)).toMatchObject({ extension: 'png', bytes: [1, 2, 3] });
  });

  it('sends no cookies and no referrer with the request', async () => {
    fakeDisk();
    const fetched = fetchMock().mockResolvedValue(imageResponse([1]));

    await resolveAvatar('ada@example.com', 32);

    expect(fetched.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  });

  it('serves a cached picture without touching the network', async () => {
    fakeDisk({ [ADA]: { extension: 'png', bytes: [1, 2, 3], storedAt: Date.now() } });
    const fetched = fetchMock();

    expect(await resolveAvatar('ada@example.com', 32)).toBe('data:image/png;base64,AQID');
    expect(fetched).not.toHaveBeenCalled();
  });

  it('never asks twice about an identity that has no picture', async () => {
    // The point of caching the negative: scrolling past an author with no
    // Gravatar must not cost a request per row, per scroll, forever.
    const disk = fakeDisk();
    const fetched = fetchMock().mockResolvedValue(notFound());

    expect(await resolveAvatar('ada@example.com', 32)).toBeNull();
    expect(disk.get(ADA)).toMatchObject({ extension: 'none', bytes: [] });
    expect(fetched).toHaveBeenCalledTimes(1);

    // Same session: answered from memory.
    expect(await resolveAvatar('ada@example.com', 32)).toBeNull();
    expect(fetched).toHaveBeenCalledTimes(1);

    // Next session: answered from disk.
    resetAvatarCache();
    expect(await resolveAvatar('ada@example.com', 32)).toBeNull();
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it('asks again once a cached answer has expired', async () => {
    const stale = Date.now() - AVATAR_CACHE_TTL_MS - 1;
    fakeDisk({ [ADA]: { extension: 'none', bytes: [], storedAt: stale } });
    const fetched = fetchMock().mockResolvedValue(imageResponse([7]));

    expect(await resolveAvatar('ada@example.com', 32)).toBe('data:image/png;base64,Bw==');
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it('tries GitHub first for a noreply address, then Gravatar', async () => {
    fakeDisk();
    const fetched = fetchMock()
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(imageResponse([5]));

    const url = await resolveAvatar('7+ada@users.noreply.github.com', 32);

    expect(fetched.mock.calls.map((call) => call[0])).toEqual([
      'https://avatars.githubusercontent.com/u/7?s=32&v=4',
      `https://www.gravatar.com/avatar/${await sha256('7+ada@users.noreply.github.com')}?s=32&d=404`,
    ]);
    expect(url).toBe('data:image/png;base64,BQ==');
  });

  it('stops at GitHub when GitHub has the picture', async () => {
    fakeDisk();
    const fetched = fetchMock().mockResolvedValue(imageResponse([5], 'image/jpeg'));

    expect(await resolveAvatar('7+ada@users.noreply.github.com', 32)).toBe(
      'data:image/jpeg;base64,BQ==',
    );
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it('makes one request when the same author wrote twenty commits', async () => {
    fakeDisk();
    const fetched = fetchMock().mockResolvedValue(imageResponse([1]));

    const urls = await Promise.all(
      Array.from({ length: 20 }, () => resolveAvatar('ada@example.com', 32)),
    );

    expect(fetched).toHaveBeenCalledTimes(1);
    expect(new Set(urls).size).toBe(1);
  });

  it('asks for nothing when the author line is not an address', async () => {
    fakeDisk();
    const fetched = fetchMock();

    expect(await resolveAvatar('Ada Lovelace', 32)).toBeNull();
    expect(await resolveAvatar('', 32)).toBeNull();
    expect(fetched).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('caches nothing when the request itself failed', async () => {
    // Offline is not "this person has no picture": remembering it on disk
    // would cost them their face for a month.
    const disk = fakeDisk();
    fetchMock().mockRejectedValue(new Error('offline'));

    expect(await resolveAvatar('ada@example.com', 32)).toBeNull();
    expect(disk.size).toBe(0);
  });

  it('caches nothing when the answer is a 200 that is not an image', async () => {
    // A captive portal or a proxy answering with HTML. Storing it would make
    // one bad answer permanent, and hand it back as a data URL.
    const disk = fakeDisk();
    fetchMock().mockResolvedValue(
      new Response('<html>sign in</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

    expect(await resolveAvatar('ada@example.com', 32)).toBeNull();
    expect(disk.size).toBe(0);
  });

  it('refuses a body far too large to be an avatar', async () => {
    // A 32-pixel picture is kilobytes. Anything past the cap is a way to
    // spend the user's memory and disk, not a face.
    const disk = fakeDisk();
    fetchMock().mockResolvedValue(
      imageResponse(Array.from({ length: MAX_AVATAR_BYTES + 1 }, () => 0)),
    );

    expect(await resolveAvatar('ada@example.com', 32)).toBeNull();
    expect(disk.size).toBe(0);
  });

  it('does not follow a redirect off the host it asked', async () => {
    // Following one would make the onward request, carrying the identity's
    // hash and this machine's IP to a host the user never agreed to.
    fakeDisk();
    const fetched = fetchMock().mockResolvedValue(imageResponse([1]));

    await resolveAvatar('ada@example.com', 32);

    expect(fetched.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  });

  it('refuses an answer that came back from somewhere else', async () => {
    // Behind that, nothing is trusted until the host that answered is the
    // host that was asked.
    const disk = fakeDisk();
    const redirected = imageResponse([1, 2, 3]);
    Object.defineProperty(redirected, 'url', {
      value: 'https://tracker.example.org/collect',
    });
    fetchMock().mockResolvedValue(redirected);

    expect(await resolveAvatar('ada@example.com', 32)).toBeNull();
    expect(disk.size).toBe(0);
  });

  it('accepts an answer from the host that was asked', async () => {
    const withUrl = imageResponse([1]);
    Object.defineProperty(withUrl, 'url', { value: GRAVATAR });
    fakeDisk();
    fetchMock().mockResolvedValue(withUrl);

    expect(await resolveAvatar('ada@example.com', 32)).toBe('data:image/png;base64,AQ==');
  });

  it('refuses a body the host announced as far too large', async () => {
    // Rejected before it is read: an announced gigabyte must not be buffered
    // into the webview just to be thrown away.
    const disk = fakeDisk();
    const huge = new Response(new Uint8Array([1]), {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': String(MAX_AVATAR_BYTES + 1),
      },
    });
    fetchMock().mockResolvedValue(huge);

    expect(await resolveAvatar('ada@example.com', 32)).toBeNull();
    expect(disk.size).toBe(0);
  });

  it('gives up on a host that never answers', async () => {
    const disk = fakeDisk();
    // What an aborted fetch looks like: the request rejects.
    fetchMock().mockRejectedValue(new DOMException('timed out', 'TimeoutError'));

    expect(await resolveAvatar('ada@example.com', 32)).toBeNull();
    expect(disk.size).toBe(0);
  });

  it('caches nothing when the host is rate limiting or refusing', async () => {
    const disk = fakeDisk();
    fetchMock().mockResolvedValue(new Response(null, { status: 429 }));

    expect(await resolveAvatar('ada@example.com', 32)).toBeNull();
    expect(disk.size).toBe(0);
  });

  it('falls back to no picture when the cache cannot be read', async () => {
    invoke.mockRejectedValue(new Error('no config directory'));
    const fetched = fetchMock().mockResolvedValue(imageResponse([1]));

    // An unreadable cache is a reason to fetch, and an unwritable one costs a
    // request next launch — neither is a reason to fail.
    expect(await resolveAvatar('ada@example.com', 32)).toBe('data:image/png;base64,AQ==');
    expect(fetched).toHaveBeenCalledTimes(1);
  });
});

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
