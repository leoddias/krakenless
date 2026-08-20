/**
 * Keeps Tab inside an open modal question.
 *
 * `aria-modal` promises assistive technology that the rest of the panel is out
 * of reach; without this the promise is false, and Tab walks straight onto the
 * Delete button of another row while a destructive question is on screen.
 */

import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

export function trapTab(event: ReactKeyboardEvent<HTMLElement>): void {
  if (event.key !== 'Tab') return;
  const focusable = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('button, input, textarea'),
  ].filter((element) => !element.hasAttribute('disabled'));
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (first === undefined || last === undefined) return;

  const active = document.activeElement;
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
    return;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
