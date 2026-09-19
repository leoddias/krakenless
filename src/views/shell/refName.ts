/**
 * Naming of refs: why a name the user typed cannot be used, and how a ref is
 * named unambiguously once it exists.
 *
 * {@link refNameError} is a deliberate mirror of `assertRefName` in
 * `src/git/argsafety.ts`, which stays the authority — this exists so the
 * rejection lands on the field the user is typing in rather than as a failed
 * command. Branch names and tag names are checked by the same git rules, so
 * they are checked by the same function here; only the noun and the example
 * change.
 */

import type { RefKind } from '../../git/types';

/**
 * The full ref path of a ref the panels show, which is how a selection names
 * one ref rather than a name several refs may share.
 *
 * `main`, `origin/main` and a tag called `main` are three different refs whose
 * short names collide — git allows all three at once, and it is the ref path
 * that tells them apart. Anything selected *through* a ref is therefore
 * remembered as this, so the branch list, the tag list and the chips in the
 * history agree on what is selected without any of them guessing at a kind.
 *
 * `HEAD` is not under `refs/` and needs no prefix; it is here so the mapping is
 * total and no caller has to special-case it.
 */
export function refPath(kind: RefKind, name: string): string {
  switch (kind) {
    case 'branch':
      return `refs/heads/${name}`;
    case 'remote-branch':
      return `refs/remotes/${name}`;
    case 'tag':
      return `refs/tags/${name}`;
    case 'head':
      return 'HEAD';
  }
}

/**
 * The short name inside a ref path: the inverse of {@link refPath}.
 *
 * `refs/heads/feat/ui` → `feat/ui`, and `refs/remotes/origin/feat/x` →
 * `origin/feat/x`, because that second one *is* the name the remote list shows
 * and groups by — the remote is the first segment of it. Only the namespace
 * prefix is removed, never a segment of the name itself, and a path that is not
 * one of the three namespaces is returned unchanged: it is a display and
 * grouping helper, not a parser anything acts on.
 */
export function shortRefName(path: string): string {
  for (const prefix of ['refs/heads/', 'refs/remotes/', 'refs/tags/']) {
    if (path.startsWith(prefix)) return path.slice(prefix.length);
  }
  return path;
}

export interface RefNoun {
  /** What the name is for, e.g. `branch` or `tag`. */
  noun: string;
  /** A full ref path of that kind, to show what *not* to type. */
  fullPathExample: string;
}

export function refNameError(name: string, kind: RefNoun): string | null {
  const a = kind.noun;
  if (name.length === 0) return `Enter a ${a} name.`;
  if (name.startsWith('-')) return `A ${a} name may not start with a dash.`;
  if (name.startsWith('+')) return `A ${a} name may not start with a plus.`;
  if (name.includes('\0')) return `A ${a} name may not contain a NUL character.`;
  if (name.startsWith('refs/')) {
    return `Use the short name, not a full ref path like "${kind.fullPathExample}".`;
  }
  if (/[\s~^:?*[\\]/.test(name)) {
    return `A ${a} name may not contain spaces or any of ~ ^ : ? * [ \\.`;
  }
  if (name.includes('..')) return `A ${a} name may not contain "..".`;
  if (name.includes('@{')) return `A ${a} name may not contain "@{".`;
  if (name.endsWith('.') || name.endsWith('/') || name.endsWith('.lock')) {
    return `A ${a} name may not end with ".", "/" or ".lock".`;
  }
  if (name.startsWith('/') || name.includes('//')) {
    return `A ${a} name may not have an empty path component.`;
  }
  if (name === '@') return `A ${a} name may not be "@".`;
  return null;
}

export const BRANCH_NOUN: RefNoun = {
  noun: 'branch',
  fullPathExample: 'refs/heads/main',
};

export const TAG_NOUN: RefNoun = { noun: 'tag', fullPathExample: 'refs/tags/v1.0' };
