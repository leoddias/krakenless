/**
 * What a fetch brought, and how to say it in one line.
 *
 * A fetch is the one operation in this app whose whole result is invisible:
 * nothing on screen changes, no file moves, and git prints its report to a
 * terminal nobody is looking at. Comparing the refs either side of it turns
 * that into an answer — both for the user, who otherwise cannot tell a working
 * fetch from a broken one, and for the app, which should only re-read its
 * panels when something actually moved.
 */

import type { FetchOptions } from '../git/commands/remote';
import type { RefSnapshot } from '../git/parsers/refsnapshot';
import { fetch as gitFetch, readRefSnapshot } from '../git/refs';

export interface FetchNews {
  /** Remote-tracking branches that did not exist here before. */
  newBranches: string[];
  /** Remote-tracking branches that now point somewhere else. */
  updatedBranches: string[];
  /** Remote-tracking branches `--prune` removed, because the remote lost them. */
  goneBranches: string[];
  newTags: string[];
  /** Tags whose target changed — rare, and worth saying out loud when it does. */
  updatedTags: string[];
  goneTags: string[];
}

const REMOTE_PREFIX = 'refs/remotes/';
const TAG_PREFIX = 'refs/tags/';

/** How many names a summary spells out before it starts counting instead. */
const NAMES_SHOWN = 3;

function empty(): FetchNews {
  return {
    newBranches: [],
    updatedBranches: [],
    goneBranches: [],
    newTags: [],
    updatedTags: [],
    goneTags: [],
  };
}

/** The name a user recognises: `origin/main`, not `refs/remotes/origin/main`. */
function displayName(refname: string): string {
  if (refname.startsWith(REMOTE_PREFIX)) return refname.slice(REMOTE_PREFIX.length);
  if (refname.startsWith(TAG_PREFIX)) return refname.slice(TAG_PREFIX.length);
  return refname;
}

/**
 * Compares two ref snapshots taken either side of a fetch.
 *
 * Refs outside `refs/remotes` and `refs/tags` are ignored rather than
 * classified: a fetch cannot move them, so their presence in a snapshot would
 * be someone else's change and reporting it here would be a lie about what the
 * fetch did.
 */
export function diffRefSnapshots(before: RefSnapshot, after: RefSnapshot): FetchNews {
  const news = empty();

  for (const [refname, oid] of after) {
    const previous = before.get(refname);
    if (previous === oid) continue;
    const name = displayName(refname);

    if (refname.startsWith(TAG_PREFIX)) {
      (previous === undefined ? news.newTags : news.updatedTags).push(name);
    } else if (refname.startsWith(REMOTE_PREFIX)) {
      (previous === undefined ? news.newBranches : news.updatedBranches).push(name);
    }
  }

  for (const refname of before.keys()) {
    if (after.has(refname)) continue;
    const name = displayName(refname);
    if (refname.startsWith(TAG_PREFIX)) news.goneTags.push(name);
    else if (refname.startsWith(REMOTE_PREFIX)) news.goneBranches.push(name);
  }

  for (const list of Object.values(news)) list.sort();
  return news;
}

export function hasNews(news: FetchNews): boolean {
  return Object.values(news).some((list) => list.length > 0);
}

/** `2 branches updated (origin/main, origin/next)`, names capped. */
function phrase(names: string[], singular: string, plural: string): string | null {
  if (names.length === 0) return null;
  const label = names.length === 1 ? singular : plural;
  const shown = names.slice(0, NAMES_SHOWN).join(', ');
  const rest = names.length - NAMES_SHOWN;
  const listed = rest > 0 ? `${shown} and ${rest} more` : shown;
  return `${names.length} ${label} (${listed})`;
}

/**
 * One sentence naming everything that arrived, or `null` when nothing did.
 *
 * Tags are named separately from branches on purpose: "a tag appeared" is the
 * fact people were missing, and folding it into a branch count would hide it
 * again.
 */
export function describeFetchNews(news: FetchNews): string | null {
  const parts = [
    phrase(news.newBranches, 'new branch', 'new branches'),
    phrase(news.updatedBranches, 'branch updated', 'branches updated'),
    phrase(
      news.goneBranches,
      'branch gone from the remote',
      'branches gone from the remote',
    ),
    phrase(news.newTags, 'new tag', 'new tags'),
    phrase(news.updatedTags, 'tag moved', 'tags moved'),
    phrase(news.goneTags, 'tag gone from the remote', 'tags gone from the remote'),
  ].filter((part): part is string => part !== null);

  if (parts.length === 0) return null;
  return `Fetched: ${parts.join(', ')}.`;
}

/**
 * Fetches, and says what moved.
 *
 * `null` means "cannot tell": one of the two snapshots failed, so the caller
 * must assume the worst and refresh. A failing *fetch* is not this function's
 * to interpret — it throws, and the caller decides whether that is news (the
 * Fetch button) or ordinary life on a train (the background schedule).
 */
export async function fetchAndCompare(
  repo: string,
  options: FetchOptions = {},
): Promise<FetchNews | null> {
  const before = await snapshotOrNull(repo);
  await gitFetch(repo, options);
  const after = await snapshotOrNull(repo);

  if (before === null || after === null) return null;
  return diffRefSnapshots(before, after);
}

async function snapshotOrNull(repo: string): Promise<RefSnapshot | null> {
  try {
    return await readRefSnapshot(repo);
  } catch {
    // Not knowing what changed is a reason to refresh everything, never a
    // reason to skip the fetch itself.
    return null;
  }
}
