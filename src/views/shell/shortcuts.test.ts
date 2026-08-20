import { describe, expect, it } from 'vitest';
import { SHORTCUT_HELP, resolveShortcut, type KeyLike } from './shortcuts';

function press(key: string, modifiers: Partial<KeyLike> = {}): KeyLike {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...modifiers,
  };
}

const IDLE = { editable: false };
const TYPING = { editable: true };

describe('resolveShortcut', () => {
  it('focuses each panel with its number', () => {
    expect(resolveShortcut(press('1', { ctrlKey: true }), IDLE)).toBe('focus-history');
    expect(resolveShortcut(press('2', { ctrlKey: true }), IDLE)).toBe('focus-refs');
    expect(resolveShortcut(press('3', { ctrlKey: true }), IDLE)).toBe('focus-changes');
    expect(resolveShortcut(press('4', { ctrlKey: true }), IDLE)).toBe('focus-diff');
  });

  it('accepts the command key as the primary modifier', () => {
    expect(resolveShortcut(press('1', { metaKey: true }), IDLE)).toBe('focus-history');
  });

  it('refreshes with either binding', () => {
    expect(resolveShortcut(press('F5'), IDLE)).toBe('refresh');
    expect(resolveShortcut(press('r', { ctrlKey: true }), IDLE)).toBe('refresh');
    expect(resolveShortcut(press('R', { ctrlKey: true }), IDLE)).toBe('refresh');
  });

  it('ignores a bare number, which is ordinary typing', () => {
    expect(resolveShortcut(press('1'), IDLE)).toBeNull();
  });

  it('never hijacks a key while the user is typing', () => {
    // A shortcut that fires mid-commit-message is worse than no shortcut.
    expect(resolveShortcut(press('F5'), TYPING)).toBeNull();
    expect(resolveShortcut(press('1', { ctrlKey: true }), TYPING)).toBeNull();
    expect(resolveShortcut(press('w', { ctrlKey: true }), TYPING)).toBeNull();
  });

  it('still commits from inside the message box', () => {
    // The one binding that has to work while typing, because that is where the
    // user is when they want it.
    expect(resolveShortcut(press('Enter', { ctrlKey: true }), TYPING)).toBe('commit');
    expect(resolveShortcut(press('Enter', { ctrlKey: true }), IDLE)).toBe('commit');
  });

  it('does not commit on a bare Enter', () => {
    expect(resolveShortcut(press('Enter'), IDLE)).toBeNull();
    expect(resolveShortcut(press('Enter'), TYPING)).toBeNull();
  });

  it('opens settings and closes the repository', () => {
    expect(resolveShortcut(press(',', { ctrlKey: true }), IDLE)).toBe('settings');
    expect(resolveShortcut(press('w', { ctrlKey: true }), IDLE)).toBe('close-repo');
  });

  it('leaves shifted variants alone, since they are browser and OS bindings', () => {
    expect(
      resolveShortcut(press('r', { ctrlKey: true, shiftKey: true }), IDLE),
    ).toBeNull();
    expect(
      resolveShortcut(press('w', { ctrlKey: true, shiftKey: true }), IDLE),
    ).toBeNull();
  });

  it('returns null for anything unbound', () => {
    expect(resolveShortcut(press('q', { ctrlKey: true }), IDLE)).toBeNull();
    expect(resolveShortcut(press('Escape'), IDLE)).toBeNull();
  });
});

describe('SHORTCUT_HELP', () => {
  it('documents every binding the resolver actually supports', () => {
    // Help that drifts from the code teaches the user something false.
    const documented = SHORTCUT_HELP.map((entry) => entry.keys).join(' ');
    expect(documented).toContain('Ctrl+1');
    expect(documented).toContain('Ctrl+R');
    expect(documented).toContain('Ctrl+Enter');
    expect(documented).toContain('Ctrl+,');
    expect(documented).toContain('Ctrl+W');
  });
});
