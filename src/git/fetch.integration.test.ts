/**
 * What a fetch actually brings back, against the real git binary.
 *
 * The tag behaviour here cannot be asserted from the argument array alone: the
 * question is not "is `--no-tags` absent" but "does the tag somebody else
 * pushed end up in this repository", and only git can answer that. Both remotes
 * are directories on disk, so nothing here touches a network.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildFetchCommand } from './commands/remote';
import { buildRefSnapshotCommand } from './commands/refsnapshot';
import { parseRefSnapshot } from './parsers/refsnapshot';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let workspace: string;
let origin: string;
let clone: string;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['--no-pager', '--literal-pathspecs', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
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
  workspace = mkdtempSync(join(tmpdir(), 'krakenless-fetch-'));
  origin = join(workspace, 'origin');
  clone = join(workspace, 'clone');

  git(workspace, ['init', '--quiet', '--initial-branch', 'main', 'origin']);
  identify(origin);
  commit(origin, 'seed.txt');

  // Line endings off at clone time, not a moment later; see the same line in
  // `pull.integration.test.ts` for what setting it afterwards costs.
  git(workspace, ['-c', 'core.autocrlf=false', 'clone', '--quiet', origin, 'clone']);
  identify(clone);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('fetch', () => {
  it('brings back a tag pointing into the history it fetched', () => {
    // `--no-tags` used to be in these arguments, and a release tag pushed by a
    // colleague simply never existed in this app.
    commit(origin, 'release.txt');
    git(origin, ['tag', 'v1.0']);

    git(clone, buildFetchCommand({ prune: true }).args);

    expect(git(clone, ['tag', '--list'])).toContain('v1.0');
  });

  it('leaves behind a tag on history it did not fetch', () => {
    // The difference between git's default and `--tags`: an old repository can
    // carry thousands of tags nobody here has any use for.
    commit(origin, 'side.txt');
    const orphan = git(origin, ['rev-parse', 'HEAD']).trim();
    git(origin, ['tag', 'orphan', orphan]);
    git(origin, ['reset', '--hard', '--quiet', 'HEAD~1']);

    git(clone, buildFetchCommand({ prune: true }).args);

    expect(git(clone, ['tag', '--list'])).not.toContain('orphan');
  });

  it('prunes a remote-tracking branch but never a tag', () => {
    git(origin, ['branch', 'topic']);
    git(origin, ['tag', 'v1.0']);
    git(clone, buildFetchCommand({ prune: true }).args);
    expect(git(clone, ['branch', '--remotes'])).toContain('origin/topic');

    git(origin, ['branch', '--delete', '--quiet', 'topic']);
    git(origin, ['tag', '--delete', 'v1.0']);
    git(clone, buildFetchCommand({ prune: true }).args);

    expect(git(clone, ['branch', '--remotes'])).not.toContain('origin/topic');
    // A tag that vanished upstream is not evidence it should vanish here: it
    // may be the only name left for a release someone still builds.
    expect(git(clone, ['tag', '--list'])).toContain('v1.0');
  });

  it('keeps a local tag even when the user configured fetch.pruneTags', () => {
    // With that config set, a bare `--prune` deletes every tag the remote does
    // not have — on a five-minute timer, and a tag is often the only name left
    // on a commit.
    git(clone, ['config', 'fetch.pruneTags', 'true']);
    git(clone, ['tag', 'pre-refactor']);

    git(clone, buildFetchCommand({ prune: true }).args);

    expect(git(clone, ['tag', '--list'])).toContain('pre-refactor');
  });

  it('takes a snapshot of exactly what the fetch moved', () => {
    commit(origin, 'news.txt');
    git(origin, ['tag', 'v2.0']);

    const before = snapshot(clone);
    git(clone, buildFetchCommand({ prune: true }).args);
    const after = snapshot(clone);

    expect([...after.keys()].sort()).toEqual([
      'refs/remotes/origin/main',
      'refs/tags/v2.0',
    ]);
    expect(after.get('refs/remotes/origin/main')).not.toBe(
      before.get('refs/remotes/origin/main'),
    );

    // A second fetch against an unchanged remote is the common case, and it
    // must leave the snapshot identical so the app redraws nothing.
    git(clone, buildFetchCommand({ prune: true }).args);
    expect([...snapshot(clone)]).toEqual([...after]);
  });
});
