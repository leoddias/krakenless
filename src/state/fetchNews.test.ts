import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describeFetchNews,
  diffRefSnapshots,
  fetchAndCompare,
  hasNews,
} from './fetchNews';
import type { RefSnapshot } from '../git/parsers/refsnapshot';

const gitFetch = vi.hoisted(() => vi.fn());
const readRefSnapshot = vi.hoisted(() => vi.fn());
vi.mock('../git/refs', () => ({ fetch: gitFetch, readRefSnapshot }));

function snapshot(entries: Record<string, string>): RefSnapshot {
  return new Map(Object.entries(entries));
}

function gitOutput(stderr = '') {
  return { stdout: '', stderr, code: 0, timedOut: false, stdoutLossy: false };
}

const OLD = '1111111111111111111111111111111111111111';
const NEW = '2222222222222222222222222222222222222222';

describe('diffRefSnapshots', () => {
  it('reports nothing when the refs are identical', () => {
    const refs = snapshot({ 'refs/remotes/origin/main': OLD });
    expect(hasNews(diffRefSnapshots(refs, refs))).toBe(false);
  });

  it('separates new, updated and pruned branches, by their short names', () => {
    const news = diffRefSnapshots(
      snapshot({
        'refs/remotes/origin/main': OLD,
        'refs/remotes/origin/gone': OLD,
      }),
      snapshot({
        'refs/remotes/origin/main': NEW,
        'refs/remotes/origin/feature': NEW,
      }),
    );

    expect(news.newBranches).toEqual(['origin/feature']);
    expect(news.updatedBranches).toEqual(['origin/main']);
    expect(news.goneBranches).toEqual(['origin/gone']);
    expect(hasNews(news)).toBe(true);
  });

  it('counts tags separately from branches', () => {
    const news = diffRefSnapshots(
      snapshot({ 'refs/tags/v1.0': OLD }),
      snapshot({ 'refs/tags/v1.0': NEW, 'refs/tags/v1.1': NEW }),
    );

    expect(news.newTags).toEqual(['v1.1']);
    expect(news.updatedTags).toEqual(['v1.0']);
    expect(news.newBranches).toEqual([]);
  });

  it('ignores refs a fetch cannot move', () => {
    // A local branch that moved while the fetch ran is the user's own commit,
    // and reporting it as fetched news would be a lie about where it came from.
    const news = diffRefSnapshots(
      snapshot({ 'refs/heads/main': OLD }),
      snapshot({ 'refs/heads/main': NEW, 'refs/stash': NEW }),
    );
    expect(hasNews(news)).toBe(false);
  });
});

describe('describeFetchNews', () => {
  it('says nothing when nothing arrived', () => {
    expect(describeFetchNews(diffRefSnapshots(snapshot({}), snapshot({})))).toBeNull();
  });

  it('names branches and tags in one line', () => {
    const news = diffRefSnapshots(
      snapshot({ 'refs/remotes/origin/main': OLD }),
      snapshot({ 'refs/remotes/origin/main': NEW, 'refs/tags/v2.0': NEW }),
    );
    expect(describeFetchNews(news)).toBe(
      'Fetched: 1 branch updated (origin/main), 1 new tag (v2.0).',
    );
  });

  it('stops naming after three and counts the rest', () => {
    const after: Record<string, string> = {};
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      after[`refs/tags/${name}`] = NEW;
    }
    expect(describeFetchNews(diffRefSnapshots(snapshot({}), snapshot(after)))).toBe(
      'Fetched: 5 new tags (a, b, c and 2 more).',
    );
  });
});

describe('fetchAndCompare', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    gitFetch.mockResolvedValue(gitOutput());
  });

  it('snapshots either side of the fetch and reports the difference', async () => {
    readRefSnapshot
      .mockResolvedValueOnce(snapshot({ 'refs/remotes/origin/main': OLD }))
      .mockResolvedValueOnce(snapshot({ 'refs/remotes/origin/main': NEW }));

    const news = await fetchAndCompare('C:/repo', { prune: true });

    expect(gitFetch).toHaveBeenCalledWith('C:/repo', { prune: true });
    expect(readRefSnapshot).toHaveBeenCalledTimes(2);
    expect(news?.updatedBranches).toEqual(['origin/main']);
  });

  it('fetches even when the snapshot before it fails, and admits it cannot tell', async () => {
    readRefSnapshot.mockRejectedValue(new Error('for-each-ref exploded'));

    await expect(fetchAndCompare('C:/repo')).resolves.toBeNull();
    expect(gitFetch).toHaveBeenCalledTimes(1);
  });

  it('lets a failing fetch through to the caller', async () => {
    readRefSnapshot.mockResolvedValue(snapshot({}));
    gitFetch.mockRejectedValue(new Error('could not resolve host'));

    await expect(fetchAndCompare('C:/repo')).rejects.toThrow(/resolve host/);
  });
});
