/**
 * The fetch summary, built from what the real git binary actually says.
 *
 * The unit tests feed `diffRefSnapshots` hand-written snapshots; this one takes
 * them from git itself, so a change in what `for-each-ref` prints shows up as a
 * failing sentence rather than as a user told "nothing new" forever. Both
 * remotes are directories, so nothing here touches a network.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildFetchCommand } from '../git/commands/remote';
import { buildRefSnapshotCommand } from '../git/commands/refsnapshot';
import { parseRefSnapshot } from '../git/parsers/refsnapshot';
import { describeFetchNews, diffRefSnapshots, hasNews } from './fetchNews';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };

let workspace: string;
let origin: string;
let clone: string;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['--no-pager', '--literal-pathspecs', ...args], {
    cwd,
    encoding: 'utf8',
    env: ENV,
  });
}

/** Runs the app's own fetch arguments, and insists git was happy with them. */
function fetch(cwd: string): void {
  const result = spawnSync(
    'git',
    ['--no-pager', ...buildFetchCommand({ prune: true }).args],
    { cwd, encoding: 'utf8', env: ENV },
  );
  expect(result.status).toBe(0);
}

function identify(repo: string): void {
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['config', 'core.autocrlf', 'false']);
}

function commit(repo: string, name: string): void {
  writeFileSync(join(repo, name), `${name}\n`, 'utf8');
  git(repo, ['add', '.']);
  git(repo, ['commit', '--quiet', '--message', name]);
}

function snapshot(repo: string) {
  return parseRefSnapshot(git(repo, buildRefSnapshotCommand().args));
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'krakenless-news-'));
  origin = join(workspace, 'origin');
  clone = join(workspace, 'clone');

  git(workspace, ['init', '--quiet', '--initial-branch', 'main', 'origin']);
  identify(origin);
  commit(origin, 'seed.txt');

  git(workspace, ['clone', '--quiet', origin, 'clone']);
  identify(clone);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('the fetch summary against real git', () => {
  it('names the branch and the tag that arrived', () => {
    commit(origin, 'news.txt');
    git(origin, ['tag', 'v2.0']);

    const before = snapshot(clone);
    fetch(clone);
    const news = diffRefSnapshots(before, snapshot(clone));

    expect(describeFetchNews(news)).toBe(
      'Fetched: 1 branch updated (origin/main), 1 new tag (v2.0).',
    );
  });

  it('says nothing at all when the remote has not moved', () => {
    const before = snapshot(clone);
    fetch(clone);
    const news = diffRefSnapshots(before, snapshot(clone));

    expect(hasNews(news)).toBe(false);
    expect(describeFetchNews(news)).toBeNull();
  });
});
