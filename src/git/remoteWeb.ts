/**
 * Turns a git remote URL into a web address for a commit.
 *
 * Two things make this worth a module of its own rather than a template
 * string. The first is that remote URLs come in five shapes — `https://`,
 * `ssh://`, `git://`, the scp-like `git@host:owner/repo`, and a local path —
 * and only some of them name a web host at all. The second is credentials: a
 * remote may carry `user:token@` in its URL, and a "copy link" that pasted a
 * personal access token into a chat window would be a leak this app caused.
 * The userinfo is dropped, always.
 *
 * When the host is not one whose commit URLs we can derive, the answer is
 * `null` and the UI says so. A wrong link is worse than no link: it looks
 * right, and it is shared before anyone clicks it.
 */

/** A remote URL split into the parts a web address needs. */
interface RemoteLocation {
  host: string;
  /** Path to the repository, no leading or trailing slash, no `.git`. */
  path: string;
}

/**
 * Hosts whose commit page lives under `/commits/` rather than `/commit/`.
 * Bitbucket Cloud is the one in common use.
 */
const COMMITS_PLURAL = new Set(['bitbucket.org']);

/**
 * Hosts we deliberately refuse to guess for. Azure DevOps addresses a commit
 * with a query string (`?version=GC<sha>`) off a path that does not appear in
 * the remote URL, so anything derived here would be a broken link.
 */
const UNSUPPORTED = [/(^|\.)dev\.azure\.com$/i, /(^|\.)visualstudio\.com$/i];

/** Strips `user@` / `user:password@` from an authority. */
function withoutCredentials(authority: string): string {
  const at = authority.lastIndexOf('@');
  return at === -1 ? authority : authority.slice(at + 1);
}

/** Drops a `:port` suffix, leaving IPv6 literals (`[::1]`) intact. */
function withoutPort(host: string): string {
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    return close === -1 ? host : host.slice(0, close + 1);
  }
  const colon = host.indexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

function tidyPath(path: string): string {
  return path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
}

/**
 * Splits a remote URL into host and repository path, or `null` when it names
 * no web host — a local path, a `file://` URL, or something unparseable.
 */
export function parseRemoteLocation(url: string): RemoteLocation | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(trimmed);
  if (scheme !== null) {
    const protocol = (scheme[1] ?? '').toLowerCase();
    // `git+ssh` and `ssh+git` are both spelled in the wild.
    const known = ['http', 'https', 'ssh', 'git', 'git+ssh', 'ssh+git'];
    if (!known.includes(protocol)) return null;
    const rest = trimmed.slice(scheme[0].length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    const host = withoutPort(withoutCredentials(rest.slice(0, slash)));
    const path = tidyPath(rest.slice(slash + 1));
    return host.length === 0 || path.length === 0 ? null : { host, path };
  }

  // scp-like: `git@host:owner/repo.git`. A Windows path (`C:/repos/app`) has
  // the same colon, so the authority must look like a host — it needs a dot or
  // be more than one character before the colon.
  const scp = /^([^/\\]+?):(?!\/)(.+)$/.exec(trimmed);
  if (scp !== null) {
    const host = withoutPort(withoutCredentials(scp[1] ?? ''));
    if (host.length <= 1) return null;
    const path = tidyPath((scp[2] ?? '').replace(/\\/g, '/'));
    return host.length === 0 || path.length === 0 ? null : { host, path };
  }

  return null;
}

/**
 * The web address of `oid` in the repository `remoteUrl` points at, or `null`
 * when one cannot be derived.
 */
export function commitWebUrl(remoteUrl: string, oid: string): string | null {
  // A revision the caller did not read out of git's own output has no business
  // being pasted into a URL.
  if (!/^[0-9a-f]{7,64}$/i.test(oid)) return null;

  const location = parseRemoteLocation(remoteUrl);
  if (location === null) return null;
  if (UNSUPPORTED.some((pattern) => pattern.test(location.host))) return null;

  const segment = COMMITS_PLURAL.has(location.host.toLowerCase()) ? 'commits' : 'commit';
  return `https://${location.host}/${location.path}/${segment}/${oid.toLowerCase()}`;
}
