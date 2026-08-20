import { describe, expect, it } from 'vitest';
import { githubAvatarUrl, isGithubNoreply } from './githubAvatar';

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

describe('isGithubNoreply', () => {
  it('recognizes both noreply forms', () => {
    expect(isGithubNoreply('12345+ada@users.noreply.github.com')).toBe(true);
    expect(isGithubNoreply('ada@users.noreply.github.com')).toBe(true);
  });

  it('does not recognize an ordinary or look-alike address', () => {
    expect(isGithubNoreply('ada@example.com')).toBe(false);
    expect(isGithubNoreply('ada@users.noreply.github.com.evil.org')).toBe(false);
  });
});
