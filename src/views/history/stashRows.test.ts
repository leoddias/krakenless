import { describe, expect, it } from 'vitest';
import { applyStashes, stashRowLabel } from './stashRows';
import type { Commit, StashEntry } from '../../git/types';

function oid(seed: string): string {
  return seed.padEnd(40, '0');
}

function commit(id: string, parents: string[] = [], subject = 'work'): Commit {
  return {
    oid: oid(id),
    shortOid: oid(id).slice(0, 7),
    parents: parents.map(oid),
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    authorDate: '2026-08-20T10:00:00+00:00',
    committerName: 'Ada',
    committerDate: '2026-08-20T10:00:00+00:00',
    subject,
    body: '',
    refs: [],
  };
}

function stash(id: string, index = 0, message = 'WIP on main: abc123 work'): StashEntry {
  return {
    ref: `stash@{${String(index)}}`,
    oid: oid(id),
    index,
    message,
    date: '2026-08-20T10:00:00+00:00',
  };
}

/**
 * The shape git actually produces: the stash commit, its index snapshot, and
 * the base commit it was taken on.
 */
function history(): Commit[] {
  return [
    commit('s', ['base', 'idx'], 'On main: WIP on main'),
    commit('idx', ['base'], 'index on main: base feat(x)'),
    commit('base', ['old'], 'feat(x): a real commit'),
    commit('old', [], 'older'),
  ];
}

const ready = (entries: StashEntry[]) => ({ state: 'ready' as const, value: entries });

describe('applyStashes', () => {
  it('drops the index snapshot and keeps the stash itself', () => {
    const result = applyStashes(history(), ready([stash('s')]));
    expect(result.commits.map((entry) => entry.subject)).toEqual([
      'On main: WIP on main',
      'feat(x): a real commit',
      'older',
    ]);
  });

  it('trims the stash to its first parent, so no edge points at a hidden row', () => {
    const result = applyStashes(history(), ready([stash('s')]));
    expect(result.commits[0]?.parents).toEqual([oid('base')]);
  });

  it('leaves the base commit its own parents', () => {
    const result = applyStashes(history(), ready([stash('s')]));
    expect(result.commits[1]?.parents).toEqual([oid('old')]);
  });

  it('reports which oid is which stash', () => {
    const result = applyStashes(history(), ready([stash('s', 2)]));
    expect(result.stashes.get(oid('s'))?.ref).toBe('stash@{2}');
    expect(result.stashes.has(oid('base'))).toBe(false);
  });

  it('handles the third parent an --include-untracked stash adds', () => {
    const commits = [
      commit('s', ['base', 'idx', 'untracked'], 'On main: WIP'),
      commit('idx', ['base']),
      commit('untracked', []),
      commit('base', []),
    ];
    const result = applyStashes(commits, ready([stash('s')]));
    expect(result.commits.map((entry) => entry.oid)).toEqual([oid('s'), oid('base')]);
  });

  it('collapses several stashes at once', () => {
    const commits = [
      commit('s1', ['base', 'i1'], 'On main: one'),
      commit('i1', ['base']),
      commit('s2', ['base', 'i2'], 'On main: two'),
      commit('i2', ['base']),
      commit('base', []),
    ];
    const result = applyStashes(commits, ready([stash('s1', 0), stash('s2', 1)]));
    expect(result.commits.map((entry) => entry.oid)).toEqual([
      oid('s1'),
      oid('s2'),
      oid('base'),
    ]);
  });

  it('never hides a commit another stash entry points at', () => {
    // Contrived, but the failure mode is losing a row the user can act on.
    const commits = [commit('s', ['base', 'other']), commit('other', []), commit('base')];
    const result = applyStashes(commits, ready([stash('s', 0), stash('other', 1)]));
    expect(result.commits.map((entry) => entry.oid)).toContain(oid('other'));
  });

  it('leaves an ordinary merge commit alone', () => {
    const commits = [commit('m', ['a', 'b'], 'merge'), commit('a'), commit('b')];
    const result = applyStashes(commits, ready([stash('zz')]));
    expect(result.commits).toHaveLength(3);
    expect(result.commits[0]?.parents).toHaveLength(2);
  });

  it('changes nothing while the stash list is still being read', () => {
    const commits = history();
    const result = applyStashes(commits, { state: 'loading' });
    expect(result.commits).toBe(commits);
    expect(result.stashes.size).toBe(0);
  });

  it('changes nothing when the stash list could not be read', () => {
    const commits = history();
    expect(applyStashes(commits, { state: 'error', message: 'no' }).commits).toBe(
      commits,
    );
  });

  it('changes nothing when there are no stashes', () => {
    const commits = history();
    expect(applyStashes(commits, ready([])).commits).toBe(commits);
  });
});

describe('stashRowLabel', () => {
  it('keeps the name for a stash the user named', () => {
    expect(stashRowLabel(stash('s', 0, 'On main: WIP on main'))).toBe('WIP on main');
  });

  it('drops the sha and subject git appends to an unnamed stash', () => {
    expect(stashRowLabel(stash('s', 0, 'WIP on main: ee84891 feat(x): thing'))).toBe(
      'WIP on main',
    );
  });

  it('keeps a branch name with a slash in it whole', () => {
    expect(stashRowLabel(stash('s', 0, 'WIP on feature/x: ee84891 thing'))).toBe(
      'WIP on feature/x',
    );
  });

  it('keeps a message that contains a colon', () => {
    expect(stashRowLabel(stash('s', 0, 'On main: fix: the parser'))).toBe(
      'fix: the parser',
    );
  });

  it('falls back to the message when git wrote neither shape', () => {
    expect(stashRowLabel(stash('s', 0, 'something else'))).toBe('something else');
  });

  it('falls back to the ref rather than showing an empty row', () => {
    expect(stashRowLabel(stash('s', 3, ''))).toBe('stash@{3}');
  });
});
