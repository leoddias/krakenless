/**
 * What deleting a tag really does, against the real git binary.
 *
 * The claims that cannot be made from an argument array. That the list reads
 * back a name `git tag --delete` answers to *while a branch of the same name
 * exists* — `%(refname:short)` prints `tags/release` in that case, which is a
 * name nothing acts on and the reason this file exists. That the local delete
 * takes the tag and leaves the branch. That the remote delete reaches the
 * right ref on the server. And that both recovery commands the UI offers
 * actually work: `update-ref` brings an annotated tag back whole, message and
 * tagger included, which is why it is offered instead of `git tag <name>
 * <commit>`.
 *
 * The remote is a directory on disk; nothing touches a network.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildDeleteTagCommand, buildTagListCommand } from './commands/tag';
import { buildDeleteRemoteTagCommand } from './commands/remote';
import { parseTags } from './parsers/tag';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let workspace: string;
let origin: string;
let mine: string;

function run(cwd: string, args: string[]): { output: string; code: number } {
  const result = spawnSync('git', ['--no-pager', '--literal-pathspecs', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
  return {
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    code: result.status ?? -1,
  };
}

function git(cwd: string, args: string[]): string {
  const { output, code } = run(cwd, args);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${output}`);
  return output.trim();
}

/** The tag list exactly as the app reads it: same command, same parser. */
function listTags(repo: string): ReturnType<typeof parseTags> {
  const { output, code } = run(repo, buildTagListCommand().args);
  if (code !== 0) throw new Error(`listing tags failed: ${output}`);
  // `run` appends a newline and stderr; the parser skips empty records.
  return parseTags(output);
}

function commitFile(repo: string, name: string, contents: string): string {
  writeFileSync(join(repo, name), contents, 'utf8');
  git(repo, ['add', name]);
  git(repo, ['commit', '--quiet', '--message', `write ${name}`]);
  return git(repo, ['rev-parse', 'HEAD']);
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'krakenless-deletetag-'));
  origin = join(workspace, 'origin');
  mine = join(workspace, 'mine');

  git(workspace, ['init', '--quiet', '--bare', '--initial-branch', 'main', 'origin']);
  git(workspace, ['clone', '--quiet', origin, 'mine']);
  git(mine, ['config', 'user.email', 'test@example.com']);
  git(mine, ['config', 'user.name', 'Test']);
  git(mine, ['config', 'core.autocrlf', 'false']);
  commitFile(mine, 'base.txt', 'base\n');
  git(mine, ['push', '--quiet', '--set-upstream', 'origin', 'main']);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('reading tags, against real git', () => {
  it('reads a name the delete answers to even when a branch shares it', () => {
    // `%(refname:short)` prints `tags/release` here, and
    // `git tag --delete tags/release` finds nothing — the row would be
    // undeletable and its restore command would create a nested
    // `refs/tags/tags/release`.
    git(mine, ['branch', 'release']);
    git(mine, ['tag', 'release']);

    const [tag] = listTags(mine);

    expect(tag?.name).toBe('release');
    expect(run(mine, buildDeleteTagCommand(tag?.name ?? '').args).code).toBe(0);
  });

  it('gives an annotated tag the commit it points into, and keeps the tag object', () => {
    const commit = git(mine, ['rev-parse', 'HEAD']);
    git(mine, ['tag', '--annotate', '--message', 'ship it', 'v2.0']);

    const [tag] = listTags(mine);

    expect(tag?.oid).toBe(commit);
    expect(tag?.object).toBe(git(mine, ['rev-parse', 'refs/tags/v2.0']));
    expect(tag?.object).not.toBe(commit);
    expect(tag?.annotated).toBe(true);
    expect(tag?.subject).toBe('ship it');
  });

  it('gives a lightweight tag no message of its own', () => {
    // git reports the *commit's* subject in that field; a commit message
    // carried as a tag's would be printed as something it is not.
    git(mine, ['tag', 'v1.0']);
    expect(listTags(mine)[0]?.subject).toBe('');
  });
});

describe('deleting a tag locally, against real git', () => {
  it('takes the tag and leaves a branch of the same name alone', () => {
    git(mine, ['branch', 'release']);
    git(mine, ['tag', 'release']);

    expect(run(mine, buildDeleteTagCommand('release').args).code).toBe(0);

    const refs = git(mine, ['for-each-ref', '--format=%(refname)']);
    expect(refs).not.toContain('refs/tags/release');
    expect(refs).toContain('refs/heads/release');
  });

  it('is undone whole by the update-ref the notice offers', () => {
    // The reason it is `update-ref <object>` and not `git tag <name> <commit>`:
    // the second resolves the tag object to its commit and recreates the tag
    // *lightweight*, silently dropping the message and the tagger.
    git(mine, ['tag', '--annotate', '--message', 'ship it', 'v2.0']);
    const [before] = listTags(mine);

    run(mine, buildDeleteTagCommand('v2.0').args);
    expect(listTags(mine)).toEqual([]);

    git(mine, ['update-ref', 'refs/tags/v2.0', before?.object ?? '']);

    expect(listTags(mine)).toEqual([before]);
    expect(git(mine, ['cat-file', '-t', 'refs/tags/v2.0'])).toBe('tag');
  });

  it('reports a tag that is not there rather than succeeding quietly', () => {
    const { code, output } = run(mine, buildDeleteTagCommand('v9.9').args);
    expect(code).not.toBe(0);
    expect(output).toMatch(/not found/i);
  });
});

describe('deleting a tag on a remote, against real git', () => {
  function publishTag(name: string, annotated: boolean): string {
    if (annotated) git(mine, ['tag', '--annotate', '--message', `about ${name}`, name]);
    else git(mine, ['tag', name]);
    git(mine, ['push', '--quiet', 'origin', `refs/tags/${name}:refs/tags/${name}`]);
    return git(mine, ['rev-parse', `refs/tags/${name}`]);
  }

  it('removes the tag on the server and nothing else', () => {
    publishTag('v1.0', false);
    publishTag('v2.0', true);

    const { code } = run(mine, buildDeleteRemoteTagCommand('origin', 'v1.0').args);

    expect(code).toBe(0);
    const refs = git(origin, ['for-each-ref', '--format=%(refname)']);
    expect(refs).not.toContain('refs/tags/v1.0');
    expect(refs).toContain('refs/tags/v2.0');
    expect(refs).toContain('refs/heads/main');
  });

  it('never hits a branch that shares the tag name', () => {
    // The mirror of the remote branch delete's own guard, and the reason the
    // ref is fully qualified on this side too.
    git(mine, ['switch', '--quiet', '--create', 'release']);
    git(mine, ['push', '--quiet', 'origin', 'release']);
    git(mine, ['switch', '--quiet', 'main']);
    publishTag('release', false);

    expect(run(mine, buildDeleteRemoteTagCommand('origin', 'release').args).code).toBe(0);

    const refs = git(origin, ['for-each-ref', '--format=%(refname)']);
    expect(refs).not.toContain('refs/tags/release');
    expect(refs).toContain('refs/heads/release');
  });

  it('is undone by the push the notice offers, annotation and all', () => {
    const object = publishTag('v2.0', true);
    run(mine, buildDeleteRemoteTagCommand('origin', 'v2.0').args);
    expect(git(origin, ['for-each-ref', '--format=%(refname)'])).not.toContain(
      'refs/tags/v2.0',
    );

    git(mine, ['push', '--quiet', 'origin', `${object}:refs/tags/v2.0`]);

    expect(git(origin, ['rev-parse', 'refs/tags/v2.0'])).toBe(object);
    expect(git(origin, ['cat-file', '-t', 'refs/tags/v2.0'])).toBe('tag');
  });

  it('exits 0 for a tag the remote never had, saying so only in a warning', () => {
    // Measured, not assumed, and the reason `deleteRemoteTag` reads the output
    // instead of trusting the exit code: git prints `- [deleted] v9.9` and
    // succeeds. Taken at face value the app would tell the user a release tag
    // is gone from the server while it sits there under the name they meant.
    const { code, output } = run(
      mine,
      buildDeleteRemoteTagCommand('origin', 'v9.9').args,
    );

    expect(code).toBe(0);
    expect(output).toMatch(/deleting a non-existent ref/i);
  });
});
