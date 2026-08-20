/**
 * Application shortcuts.
 *
 * Kept as a pure mapping from key event to intent so the bindings can be tested
 * without a DOM, and so the list of what the app claims to support lives in one
 * readable place rather than spread across handlers.
 */

export type Shortcut =
  | 'refresh'
  | 'focus-history'
  | 'focus-changes'
  | 'focus-diff'
  | 'focus-refs'
  | 'commit'
  | 'settings'
  | 'close-repo';

/** The subset of a keyboard event this mapping needs. */
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Where the event came from, so typing in a field is never hijacked. */
export interface Origin {
  /** True when focus is in a text input, textarea or contenteditable. */
  editable: boolean;
}

const PANEL_KEYS: Record<string, Shortcut> = {
  '1': 'focus-history',
  '2': 'focus-refs',
  '3': 'focus-changes',
  '4': 'focus-diff',
};

/**
 * Resolves a key event to an intent, or `null` when nothing should happen.
 *
 * A shortcut that fires while the user is typing a commit message is worse than
 * no shortcut at all, so anything without a modifier is refused outright when
 * focus is in an editable field — including the plain `F5` case, which is
 * harmless, for one consistent rule rather than a list of exceptions.
 */
export function resolveShortcut(event: KeyLike, origin: Origin): Shortcut | null {
  const primary = event.ctrlKey || event.metaKey;

  // Ctrl+Enter commits from inside the message box: that is the one binding
  // that has to work *while* typing.
  if (primary && event.key === 'Enter') return 'commit';

  if (origin.editable) return null;

  if (event.key === 'F5' && !primary) return 'refresh';
  if (primary && event.key.toLowerCase() === 'r' && !event.shiftKey) return 'refresh';

  if (primary && PANEL_KEYS[event.key] !== undefined) {
    return PANEL_KEYS[event.key] ?? null;
  }

  if (primary && event.key === ',') return 'settings';
  if (primary && event.key.toLowerCase() === 'w' && !event.shiftKey) return 'close-repo';

  return null;
}

/** Human-readable list, for a help surface and for the settings screen. */
export const SHORTCUT_HELP: readonly { keys: string; does: string }[] = [
  { keys: 'Ctrl+1 … Ctrl+4', does: 'Focus history, branches, working tree, diff' },
  { keys: 'Ctrl+R or F5', does: 'Re-read the repository' },
  { keys: 'Ctrl+Enter', does: 'Commit what is staged' },
  { keys: 'Ctrl+,', does: 'Open settings' },
  { keys: 'Ctrl+W', does: 'Close the repository' },
];
