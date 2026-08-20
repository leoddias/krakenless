/**
 * Copying text to the system clipboard.
 *
 * The async Clipboard API is the route, and it is not always there: it needs a
 * secure context, and a headless or older webview may not expose it at all. The
 * fallback is the pre-2020 selection trick, which works anywhere a document
 * does. Failure is reported as `false` rather than thrown — a copy that did not
 * happen has to be *said*, because the user's next action is to paste, and a
 * silent failure pastes whatever was on the clipboard before.
 */

/** Copies `text`, returning whether it actually landed on the clipboard. */
export async function copyText(text: string): Promise<boolean> {
  const api = globalThis.navigator?.clipboard;
  if (api !== undefined) {
    try {
      await api.writeText(text);
      return true;
    } catch {
      // Denied or unavailable in this context; the fallback below may still work.
    }
  }
  return copyViaSelection(text);
}

/**
 * The fallback: a textarea off screen, selected, and copied.
 *
 * It must be in the document and visible to the layout engine for the
 * selection to exist, so it is moved off screen rather than hidden — a
 * `display: none` element cannot be selected, and the copy silently does
 * nothing.
 */
function copyViaSelection(text: string): boolean {
  if (typeof document === 'undefined') return false;

  const holder = document.createElement('textarea');
  holder.value = text;
  holder.setAttribute('readonly', '');
  holder.setAttribute('aria-hidden', 'true');
  holder.style.position = 'fixed';
  holder.style.top = '-1000px';
  holder.style.opacity = '0';

  document.body.append(holder);
  try {
    holder.select();
    // Deprecated, and the only thing available when the async API is not.
    // eslint-disable-next-line deprecation/deprecation
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    holder.remove();
  }
}
