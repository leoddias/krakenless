/**
 * The shape of a text file, and how to put it in and out of a text box.
 *
 * A `<textarea>` speaks one dialect of text: LF endings, no byte-order mark,
 * whatever the user typed at the end. A file on disk speaks whichever dialect
 * it was written in. Handing the box's dialect back to the file rewrites every
 * line of a CRLF file, which turns a one-word edit into a diff of the whole
 * file — and, with `core.autocrlf` in the picture, into a commit nobody can
 * review. So the shape is measured on the way in and restored on the way out,
 * and files whose shape cannot survive the round trip are refused rather than
 * quietly reformatted.
 */

export type Eol = 'lf' | 'crlf';

export interface TextShape {
  /** The file began with U+FEFF, which some Windows tools require. */
  bom: boolean;
  eol: Eol;
  /** The file ended with a line ending. POSIX text files do; many editors care. */
  finalNewline: boolean;
}

const BOM = '﻿';

/** How many endings of each kind the text contains. */
export function countEndings(raw: string): { crlf: number; lf: number } {
  const crlf = raw.match(/\r\n/g)?.length ?? 0;
  // Every LF that is not the tail of a CRLF pair.
  const lf = (raw.match(/\n/g)?.length ?? 0) - crlf;
  return { crlf, lf };
}

/**
 * True when the file uses both endings.
 *
 * Such a file cannot be edited here: the text box reports every ending as LF,
 * so which lines were CRLF is information that does not survive being loaded,
 * and any restoration on save would be a guess applied to the whole file.
 */
export function hasMixedEndings(raw: string): boolean {
  const { crlf, lf } = countEndings(raw);
  return crlf > 0 && lf > 0;
}

/** Measures the file so the same shape can be restored on save. */
export function readShape(raw: string): TextShape {
  const { crlf, lf } = countEndings(raw);
  return {
    bom: raw.startsWith(BOM),
    // A file with no endings at all is written back as LF, which is what a new
    // line typed into the box would have been anyway.
    eol: crlf > 0 && lf === 0 ? 'crlf' : 'lf',
    finalNewline: /\r?\n$/.test(raw),
  };
}

/** The file as the text box wants it: no mark, LF endings. */
export function toEditor(raw: string): string {
  const withoutBom = raw.startsWith(BOM) ? raw.slice(BOM.length) : raw;
  return withoutBom.replace(/\r\n/g, '\n');
}

/**
 * The box's text as the file wants it.
 *
 * The final newline is restored rather than preserved from the box: a user who
 * deletes the last line should not silently drop the trailing newline the file
 * has always had, and a file that never had one should not grow one.
 */
export function fromEditor(text: string, shape: TextShape): string {
  // Normalized first: a paste can carry CRLF into the box even though the box
  // itself reports LF, and the file must end up with exactly one dialect.
  let body = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const hadNewline = body.endsWith('\n');
  if (shape.finalNewline && !hadNewline && body !== '') body += '\n';
  if (!shape.finalNewline && hadNewline) body = body.replace(/\n+$/, '');
  if (shape.eol === 'crlf') body = body.replace(/\n/g, '\r\n');
  return shape.bom ? BOM + body : body;
}

/**
 * Why this file must not be edited in a text box, or `null` when it can be.
 *
 * Each of these is a case where saving would destroy something the editor
 * cannot see — so the answer is a sentence the user can act on, not a disabled
 * button with no explanation.
 */
export function refusalFor(raw: string, lossy: boolean): string | null {
  if (lossy) {
    return 'This file is not valid UTF-8 text. Editing it here would replace the bytes it could not decode with question marks, so Krakenless will not open it.';
  }
  if (raw.includes('\0')) {
    // Valid UTF-8 can still be a binary format. A NUL is the same signal git
    // itself uses to call a file binary.
    return 'This file contains NUL bytes, which means it is binary rather than text. Open it in the tool that understands its format.';
  }
  if (hasMixedEndings(raw)) {
    return 'This file mixes CRLF and LF line endings. A text box reports every line the same way, so saving would rewrite the endings of the whole file. Open it in your editor instead.';
  }
  return null;
}
