/**
 * GitHub avatars, derived from the commit email alone.
 *
 * A GitHub account with "keep my email private" turned on commits as
 * `<id>+<login>@users.noreply.github.com`, and that number *is* the account id.
 * `https://avatars.githubusercontent.com/u/<id>` serves that account's picture,
 * so the URL can be built from the commit itself — no API call, no token, no
 * rate limit, and no email ever leaves the machine.
 *
 * Everything else returns `null`. Resolving an ordinary address would mean
 * asking GitHub's search API who owns it, which needs an account and sends a
 * real email address to a third party; the derived badge in `avatar.ts` covers
 * those authors instead. This module builds a URL and nothing more — whether
 * that URL is ever requested is the user's setting to make (ADR-0019).
 */

/** The one host whose noreply addresses carry an account id. */
const NOREPLY_HOST = 'users.noreply.github.com';

/**
 * Matches `<digits>+<login>@users.noreply.github.com` and captures the id.
 *
 * Anchored at both ends, and the host is matched literally rather than as a
 * suffix: `1+a@users.noreply.github.com.example.org` is a domain someone else
 * controls, and treating it as GitHub's would send a request there.
 */
const NOREPLY = /^([0-9]{1,12})\+[^@\s]+@users\.noreply\.github\.com$/i;

/**
 * URL of the author's GitHub picture, or `null` when the commit does not say
 * who they are on GitHub.
 *
 * @param size Requested edge length in pixels; GitHub serves a square.
 */
export function githubAvatarUrl(email: string, size: number): string | null {
  const match = NOREPLY.exec(email.trim());
  const id = match?.[1];
  if (id === undefined) return null;
  return `https://avatars.githubusercontent.com/u/${id}?s=${String(Math.round(size))}&v=4`;
}

/** True when the address belongs to GitHub's noreply domain, id or not. */
export function isGithubNoreply(email: string): boolean {
  return email.trim().toLowerCase().endsWith(`@${NOREPLY_HOST}`);
}
