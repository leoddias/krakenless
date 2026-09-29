import { describe, expect, it } from 'vitest';
import type { Commit } from '../../git/types';
import {
  commitMatches,
  commitMessage,
  findMatches,
  splitMatches,
  stepMatch,
} from './commitSearch';

function commit(subject: string, body = '', oid = 'a'.repeat(40)): Commit {
  return {
    oid,
    shortOid: oid.slice(0, 7),
    parents: [],
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    authorDate: '2026-09-01T12:00:00Z',
    committerName: 'Ada',
    committerDate: '2026-09-01T12:00:00Z',
    subject,
    body,
    refs: [],
  };
}

describe('commitMatches', () => {
  it('finds the query in the subject, ignoring case', () => {
    expect(commitMatches(commit('Fix the Parser'), 'parser')).toBe(true);
    expect(commitMatches(commit('fix the parser'), 'PARSER')).toBe(true);
  });

  it('finds the query in the body', () => {
    expect(commitMatches(commit('chore: tidy', 'Closes the login bug'), 'login')).toBe(
      true,
    );
  });

  it('ignores whitespace around the query', () => {
    expect(commitMatches(commit('add tags'), '  tags ')).toBe(true);
  });

  it('matches nothing for an empty or blank query', () => {
    expect(commitMatches(commit('anything'), '')).toBe(false);
    expect(commitMatches(commit('anything'), '   ')).toBe(false);
  });

  it('does not match across the seam between subject and body', () => {
    expect(commitMatches(commit('add', 'tags'), 'add tags')).toBe(false);
  });

  it('does not match a message without the query', () => {
    expect(commitMatches(commit('add tags', 'and a body'), 'branch')).toBe(false);
  });

  it('treats the query as text, not a pattern', () => {
    expect(commitMatches(commit('bump to 1.0'), '1.0')).toBe(true);
    expect(commitMatches(commit('bump to 110'), '1.0')).toBe(false);
    expect(commitMatches(commit('fix (a|b)'), '(a|b)')).toBe(true);
  });

  it('never matches a worktree row, which has no message', () => {
    expect(commitMatches(commit('feature', '', 'worktree:/src/feature'), 'feature')).toBe(
      false,
    );
  });
});

describe('findMatches', () => {
  it('returns the matching positions in list order', () => {
    const commits = [commit('feat: a'), commit('fix: b'), commit('feat: c')];
    expect(findMatches(commits, 'feat')).toEqual([0, 2]);
  });

  it('returns nothing for an empty query', () => {
    expect(findMatches([commit('a')], '')).toEqual([]);
  });

  it('searches what the caller says a row shows, when it says', () => {
    // A stash row shows its label, not git's "WIP on main: <sha> <subject>".
    const stash = commit('WIP on main: abc1234 feat: add tags', '', 'b'.repeat(40));
    const shown = (entry: Commit): string =>
      entry.oid === stash.oid ? 'WIP on main' : commitMessage(entry);
    expect(findMatches([commit('feat: tags'), stash], 'tags', shown)).toEqual([0]);
  });
});

describe('stepMatch', () => {
  const matches = [2, 5, 9];

  it('goes to the next match after the current one, wrapping to the first', () => {
    expect(stepMatch(matches, 2, 1)).toBe(5);
    expect(stepMatch(matches, 3, 1)).toBe(5);
    expect(stepMatch(matches, 9, 1)).toBe(2);
  });

  it('goes to the previous match, wrapping to the last', () => {
    expect(stepMatch(matches, 5, -1)).toBe(2);
    expect(stepMatch(matches, 6, -1)).toBe(5);
    expect(stepMatch(matches, 2, -1)).toBe(9);
  });

  it('stays on the current row while typing if it still matches', () => {
    expect(stepMatch(matches, 5, 0)).toBe(5);
  });

  it('lands on the first match after the current row while typing', () => {
    expect(stepMatch(matches, 6, 0)).toBe(9);
    expect(stepMatch(matches, 10, 0)).toBe(2);
  });

  it('starts from the top when nothing is selected', () => {
    expect(stepMatch(matches, -1, 0)).toBe(2);
    expect(stepMatch(matches, -1, 1)).toBe(2);
    expect(stepMatch(matches, -1, -1)).toBe(9);
  });

  it('answers null when there is no match', () => {
    expect(stepMatch([], 0, 0)).toBeNull();
    expect(stepMatch([], 0, 1)).toBeNull();
    expect(stepMatch([], 0, -1)).toBeNull();
  });
});

describe('splitMatches', () => {
  it('marks every occurrence and keeps the original casing', () => {
    expect(splitMatches('Tag the TAGS', 'tag')).toEqual([
      { text: 'Tag', match: true },
      { text: ' the ', match: false },
      { text: 'TAG', match: true },
      { text: 'S', match: false },
    ]);
  });

  it('returns the text unmarked when nothing matches', () => {
    expect(splitMatches('add tags', 'branch')).toEqual([
      { text: 'add tags', match: false },
    ]);
  });

  it('returns the text unmarked for an empty query', () => {
    expect(splitMatches('add tags', ' ')).toEqual([{ text: 'add tags', match: false }]);
  });

  it('returns nothing for empty text', () => {
    expect(splitMatches('', 'a')).toEqual([]);
  });

  it('leaves text unmarked when lower-casing changes its length', () => {
    // `İ` lower-cases to two code units, which would shift every offset after it.
    expect(splitMatches('İstanbul fix', 'fix')).toEqual([
      { text: 'İstanbul fix', match: false },
    ]);
  });

  it('does not mark overlapping occurrences twice', () => {
    expect(splitMatches('aaa', 'aa')).toEqual([
      { text: 'aa', match: true },
      { text: 'a', match: false },
    ]);
  });
});
