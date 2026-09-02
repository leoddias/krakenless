/**
 * Making release notes readable in a dialog that cannot render Markdown.
 *
 * The notes come from the GitHub release body, which is Markdown written for a
 * web page: `**bold**`, `##` headings, `- ` bullets, and a generated changelog
 * full of link syntax. Dropped into a plain text node they read as punctuation
 * noise, and the first version of this feature made it worse by clipping the
 * result mid-sentence.
 *
 * This does not render Markdown — that would be a parser, and a parser for
 * text arriving over the network is a thing to own deliberately. It removes the
 * markers that hurt most when shown literally, and leaves everything else
 * exactly as written.
 */

/** Longest notes worth showing; past this a reader wants the release page. */
const MAX_LENGTH = 4000;

/**
 * Cuts at a line boundary at or before `limit`, so nothing ends mid-sentence.
 *
 * Falls back to a hard cut only when the first line is itself longer than the
 * limit, which no release note has ever been but which must not produce an
 * empty result.
 */
function cutAtLine(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const lastBreak = head.lastIndexOf('\n');
  return (lastBreak > 0 ? head.slice(0, lastBreak) : head).trimEnd();
}

/**
 * Turns a release body into something worth putting in a dialog.
 *
 * Returns `''` for anything with no words in it, which the dialog reads as
 * "show no notes section at all" — an empty bordered box is worse than none.
 */
export function plainNotes(text: unknown): string {
  if (typeof text !== 'string') return '';

  const cleaned = text
    .replace(/\r\n?/g, '\n')
    // `**bold**` and `__bold__`. Single `*` is left alone: it is a bullet as
    // often as it is emphasis, and stripping it eats list markers.
    .replace(/\*\*(.+?)\*\*/gs, '$1')
    .replace(/__(.+?)__/gs, '$1')
    // `## Heading` -> `Heading`. The hashes carry no meaning without styling.
    .replace(/^#{1,6}[ \t]+/gm, '')
    // `[text](url)` -> `text`. The URL is not clickable here and is usually
    // longer than the words around it.
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    // Any run of blank lines becomes one: generated changelogs are airy, and
    // vertical space is the scarce thing in a dialog.
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // A letter or a digit, not merely a non-space: a body of stray punctuation —
  // `****`, a lone `---` rule — has no words in it and is not worth a box.
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return '';

  const trimmed = cutAtLine(cleaned, MAX_LENGTH);
  return trimmed.length < cleaned.length ? `${trimmed}\n…` : trimmed;
}
