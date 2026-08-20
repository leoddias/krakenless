import type { StatusEntry } from '../../git/types';

/**
 * What each conflict type means, in the terms the user has to decide between.
 *
 * `UU`/`AA` are content conflicts — two edits to reconcile. `DU`/`UD`/`DD` are
 * keep-vs-delete, where "resolve the text" is not the question at all, and a
 * merge tool would be the wrong offer.
 */
export function conflictDescription(kind: StatusEntry['conflictKind']): string {
  switch (kind) {
    case 'UU':
      return 'Both sides changed this file.';
    case 'AA':
      return 'Both sides added this file.';
    case 'DU':
      return 'You deleted it; they changed it.';
    case 'UD':
      return 'They deleted it; you changed it.';
    case 'DD':
      return 'Both sides deleted it.';
    case 'AU':
      return 'You added it; they changed it.';
    case 'UA':
      return 'They added it; you changed it.';
    default:
      return 'This file is conflicted.';
  }
}

/** True when a merge tool is a sensible offer for this conflict. */
export function offersMergetool(kind: StatusEntry['conflictKind']): boolean {
  // A delete-vs-modify conflict has no two versions of text to merge; the
  // decision is keep or remove, and a merge tool would misrepresent that.
  return kind === 'UU' || kind === 'AA';
}
