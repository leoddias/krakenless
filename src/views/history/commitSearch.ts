/**
 * Finding commits by their message, within the history already on screen.
 *
 * Deliberately a filter over the loaded list rather than a `git log --grep`:
 * a match is only useful if it can be selected, and a commit older than the
 * loaded page has no row to select (ADR-0060). The bar says how far back it
 * looked, so a miss is never read as "no such commit exists".
 *
 * Pure so the rules — what counts as a match, where Enter goes next — are
 * asserted without rendering a list.
 */

import type { Commit } from '../../git/types';
import { isWorktreeRow } from './worktreeRows';

/** Dispatched on the History panel to open its find bar (Ctrl+F). */
export const FIND_COMMITS_EVENT = 'krakenless:find-commits';

/**
 * Selector for the element listening for {@link FIND_COMMITS_EVENT}. Not the
 * panel's label: the layout wraps the history in a region of the same name,
 * and an event sent there never reaches the list inside it.
 */
export const FIND_COMMITS_TARGET = '[data-find-commits]';

/** Whitespace around a query is never what the user is looking for. */
export function normalizeQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

/** What a commit is searched by, unless the caller says otherwise. */
export type MessageOf = (commit: Commit) => string;

/**
 * Subject and body both count: the keyword a user remembers is as often in the
 * explanation as in the headline. Joined by a newline, which a one-line query
 * cannot contain, so no match straddles the seam.
 */
export function commitMessage(commit: Commit): string {
  return `${commit.subject}\n${commit.body}`;
}

/**
 * Whether a commit's message contains the query, ignoring case. An empty query
 * matches nothing, so an empty bar never dims the whole list.
 */
export function commitMatches(
  commit: Commit,
  query: string,
  messageOf: MessageOf = commitMessage,
): boolean {
  const needle = normalizeQuery(query);
  if (needle === '') return false;
  // A worktree's WIP row borrows a commit's shape but has no message of its
  // own, and it cannot be selected either.
  if (isWorktreeRow(commit.oid)) return false;
  return messageOf(commit).toLocaleLowerCase().includes(needle);
}

/** Positions in `commits` whose message matches, in list order. */
export function findMatches(
  commits: readonly Commit[],
  query: string,
  messageOf: MessageOf = commitMessage,
): number[] {
  const matches: number[] = [];
  commits.forEach((commit, position) => {
    if (commitMatches(commit, query, messageOf)) matches.push(position);
  });
  return matches;
}

/**
 * The match to go to from `current`, a position in the commit list or `-1`
 * when nothing in it is selected.
 *
 * `1` is the next match strictly after `current`, `-1` the one strictly
 * before, both wrapping around — Enter on the last match goes back to the top,
 * as every find bar does. `0` is where typing lands: `current` itself when it
 * still matches, so narrowing a query does not move a selection that is still
 * right, otherwise the first match after it. Returns `null` when there is no
 * match at all.
 */
export function stepMatch(
  matches: readonly number[],
  current: number,
  direction: -1 | 0 | 1,
): number | null {
  if (matches.length === 0) return null;
  if (direction === -1) {
    for (let at = matches.length - 1; at >= 0; at -= 1) {
      const position = matches[at];
      if (position !== undefined && position < current) return position;
    }
    return matches[matches.length - 1] ?? null;
  }
  const from = direction === 0 ? current : current + 1;
  return matches.find((position) => position >= from) ?? matches[0] ?? null;
}

/** A run of text, and whether it is part of a match. */
export interface TextPart {
  text: string;
  match: boolean;
}

/**
 * Splits `text` around every case-insensitive occurrence of the query, so the
 * subject can mark what was found. The original casing is kept.
 *
 * Lower-casing can change a string's length (`İ` becomes two code units), and
 * then offsets found in the lowered copy would cut the original in the wrong
 * place. Such text is returned whole and unmarked rather than mis-marked; the
 * row is still flagged as a match.
 */
export function splitMatches(text: string, query: string): TextPart[] {
  const needle = normalizeQuery(query);
  const haystack = text.toLocaleLowerCase();
  if (needle === '' || haystack.length !== text.length) {
    return text === '' ? [] : [{ text, match: false }];
  }
  const parts: TextPart[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    if (at > from) parts.push({ text: text.slice(from, at), match: false });
    parts.push({ text: text.slice(at, at + needle.length), match: true });
    from = at + needle.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false });
  return parts;
}
