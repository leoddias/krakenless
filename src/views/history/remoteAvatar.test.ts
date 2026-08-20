import { describe, expect, it } from 'vitest';
import {
  AVATAR_CACHE_TTL_MS,
  avatarCacheKey,
  avatarIdentity,
  avatarSources,
  contentTypeForExtension,
  extensionForContentType,
  githubAvatarUrl,
  gravatarUrl,
  isCacheEntryFresh,
  sha256Hex,
} from './remoteAvatar';

/** SHA-256 of `ada@example.com`, the identity used throughout these tests. */
const ADA = 'b5fc85e55755f9e0d030a10ab4429b6b2944855f9a0d60077fe832becbc41d72';

describe('avatarIdentity', () => {
  it('lowercases and trims, so one person is one cached identity', () => {
    expect(avatarIdentity('  Ada@Example.COM ')).toBe('ada@example.com');
  });

  it('refuses anything that is not shaped like an address', () => {
    // Only an address may become a request; a name or a fragment must not.
    expect(avatarIdentity('Ada Lovelace')).toBeNull();
    expect(avatarIdentity('')).toBeNull();
    expect(avatarIdentity('ada@')).toBeNull();
    expect(avatarIdentity('@example.com')).toBeNull();
    expect(avatarIdentity('ada@example')).toBeNull();
    expect(avatarIdentity('ada@ex ample.com')).toBeNull();
    expect(avatarIdentity('ada@a@example.com')).toBeNull();
  });
});

describe('sha256Hex', () => {
  it('produces the digest Gravatar expects', async () => {
    // Known vector: SHA-256 of the empty string.
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('keys the cache on the normalised address', async () => {
    expect(await avatarCacheKey('ada@example.com')).toBe(ADA);
    expect(await avatarCacheKey('ada@example.com')).toBe(
      await sha256Hex('ada@example.com'),
    );
  });
});

describe('githubAvatarUrl', () => {
  it('builds the URL from the id a noreply address carries', () => {
    expect(githubAvatarUrl('12345+ada@users.noreply.github.com', 16)).toBe(
      'https://avatars.githubusercontent.com/u/12345?s=16&v=4',
    );
  });

  it('ignores case and surrounding space, as email domains are insensitive', () => {
    expect(githubAvatarUrl('  99+Ada@Users.NoReply.GitHub.com  ', 32)).toBe(
      'https://avatars.githubusercontent.com/u/99?s=32&v=4',
    );
  });

  it('rounds the size, since it is interpolated into a URL', () => {
    expect(githubAvatarUrl('1+a@users.noreply.github.com', 15.6)).toContain('s=16');
  });

  it('refuses the old noreply form, which carries no id', () => {
    // `ada@users.noreply.github.com` would need GitHub's search API to resolve,
    // which needs an account — the whole thing this avoids.
    expect(githubAvatarUrl('ada@users.noreply.github.com', 16)).toBeNull();
  });

  it('refuses a look-alike domain someone else controls', () => {
    // A suffix match here would send a request to an attacker's host, carrying
    // the user's IP, for every commit they authored in the repository.
    expect(githubAvatarUrl('1+a@users.noreply.github.com.example.org', 16)).toBeNull();
    expect(githubAvatarUrl('1+a@evil-users.noreply.github.com', 16)).toBeNull();
    expect(githubAvatarUrl('1+a@users.noreply.github.com.evil', 16)).toBeNull();
  });

  it('refuses an ordinary address rather than asking who owns it', () => {
    expect(githubAvatarUrl('ada@example.com', 16)).toBeNull();
    expect(githubAvatarUrl('', 16)).toBeNull();
  });

  it('refuses an id that is not a plain number', () => {
    expect(githubAvatarUrl('12a45+ada@users.noreply.github.com', 16)).toBeNull();
    expect(githubAvatarUrl('+ada@users.noreply.github.com', 16)).toBeNull();
    expect(githubAvatarUrl('-1+ada@users.noreply.github.com', 16)).toBeNull();
  });

  it('refuses an id long enough to be something other than an account', () => {
    expect(
      githubAvatarUrl(`${'9'.repeat(13)}+ada@users.noreply.github.com`, 16),
    ).toBeNull();
  });

  it('refuses an address with a second @, which is not one identity', () => {
    expect(githubAvatarUrl('1+a@b@users.noreply.github.com', 16)).toBeNull();
  });
});

describe('gravatarUrl', () => {
  it('asks Gravatar by hash, and for a 404 rather than an invented picture', () => {
    // `d=404` is what makes "this identity has no picture" distinguishable
    // from Gravatar's generated default, which is what the badge replaces.
    expect(gravatarUrl(ADA, 32)).toBe(
      `https://www.gravatar.com/avatar/${ADA}?s=32&d=404`,
    );
  });

  it('never lets a value that is not our hash steer the path off the host', () => {
    // The hash is interpolated into a URL. Anything but 64 hex digits — a
    // traversal, a host, a query — is refused before that happens.
    expect(gravatarUrl('../../evil.example.org/x', 32)).toBeNull();
    expect(gravatarUrl(`${ADA}@evil.example.org`, 32)).toBeNull();
    expect(gravatarUrl(ADA.toUpperCase(), 32)).toBeNull();
    expect(gravatarUrl(ADA.slice(0, 63), 32)).toBeNull();
    expect(gravatarUrl(`${ADA}0`, 32)).toBeNull();
    expect(gravatarUrl('', 32)).toBeNull();
  });

  it('rounds the size and never asks for a zero-pixel picture', () => {
    expect(gravatarUrl(ADA, 15.6)).toContain('s=16');
    expect(gravatarUrl(ADA, 0)).toContain('s=1');
  });
});

describe('avatarSources', () => {
  it('sends an ordinary address to Gravatar and nowhere else', () => {
    expect(avatarSources('ada@example.com', ADA, 32)).toEqual([
      `https://www.gravatar.com/avatar/${ADA}?s=32&d=404`,
    ]);
  });

  it('tries GitHub first for a noreply address, then Gravatar', () => {
    const sources = avatarSources('7+ada@users.noreply.github.com', ADA, 32);
    expect(sources[0]).toBe('https://avatars.githubusercontent.com/u/7?s=32&v=4');
    expect(sources[1]).toBe(`https://www.gravatar.com/avatar/${ADA}?s=32&d=404`);
  });

  it('never reaches a look-alike host, whatever the address claims', () => {
    // The only hosts this app may ever contact for a picture are these two.
    const hosts = [
      'ada@example.com',
      '1+a@users.noreply.github.com.evil.org',
      '1+a@evil-users.noreply.github.com',
      'x@gravatar.com.evil.org',
    ].flatMap((email) => avatarSources(email, ADA, 32).map((url) => new URL(url).host));

    // Not one of them resolves to GitHub, and none of them invents a host of
    // their own: the only place any of these can be looked up is Gravatar.
    expect(new Set(hosts)).toEqual(new Set(['www.gravatar.com']));
  });

  it('yields nothing at all when the hash is not one of ours', () => {
    expect(avatarSources('ada@example.com', 'not-a-hash', 32)).toEqual([]);
  });
});

describe('content types', () => {
  it('maps the image types worth caching, and only those', () => {
    expect(extensionForContentType('image/png')).toBe('png');
    expect(extensionForContentType('image/jpeg; charset=binary')).toBe('jpg');
    expect(extensionForContentType('IMAGE/GIF')).toBe('gif');
    expect(extensionForContentType('image/webp')).toBe('webp');
  });

  it('refuses anything that is not an image, so HTML is never cached', () => {
    expect(extensionForContentType('text/html')).toBeNull();
    expect(extensionForContentType('image/svg+xml')).toBeNull();
    expect(extensionForContentType(null)).toBeNull();
    expect(extensionForContentType('')).toBeNull();
  });

  it('rebuilds the type a stored extension came from', () => {
    expect(contentTypeForExtension('jpg')).toBe('image/jpeg');
    expect(contentTypeForExtension('png')).toBe('image/png');
    expect(contentTypeForExtension('none')).toBeNull();
    expect(contentTypeForExtension('exe')).toBeNull();
  });
});

describe('isCacheEntryFresh', () => {
  const NOW = 1_800_000_000_000;

  it('keeps an entry for thirty days', () => {
    expect(AVATAR_CACHE_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(isCacheEntryFresh(NOW, NOW)).toBe(true);
    expect(isCacheEntryFresh(NOW - AVATAR_CACHE_TTL_MS + 1, NOW)).toBe(true);
  });

  it('expires it after that, so a new picture can appear', () => {
    expect(isCacheEntryFresh(NOW - AVATAR_CACHE_TTL_MS, NOW)).toBe(false);
    expect(isCacheEntryFresh(0, NOW)).toBe(false);
  });

  it('treats a timestamp from the future as stale rather than eternal', () => {
    expect(isCacheEntryFresh(NOW + 1, NOW)).toBe(false);
    expect(isCacheEntryFresh(Number.NaN, NOW)).toBe(false);
    expect(isCacheEntryFresh(Number.POSITIVE_INFINITY, NOW)).toBe(false);
  });
});
