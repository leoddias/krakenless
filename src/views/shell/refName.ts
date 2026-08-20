/**
 * Why a ref name the user typed cannot be used, in words for the field.
 *
 * A deliberate mirror of `assertRefName` in `src/git/argsafety.ts`, which stays
 * the authority — this exists so the rejection lands on the field the user is
 * typing in rather than as a failed command. Branch names and tag names are
 * checked by the same git rules, so they are checked by the same function here;
 * only the noun and the example change.
 */

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
