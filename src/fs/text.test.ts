import { describe, expect, it } from 'vitest';
import {
  countEndings,
  fromEditor,
  hasMixedEndings,
  readShape,
  refusalFor,
  toEditor,
} from './text';

const BOM = '﻿';

describe('countEndings', () => {
  it('does not count the LF of a CRLF pair twice', () => {
    expect(countEndings('a\r\nb\r\n')).toEqual({ crlf: 2, lf: 0 });
  });

  it('counts a file that uses both', () => {
    expect(countEndings('a\r\nb\nc')).toEqual({ crlf: 1, lf: 1 });
  });

  it('counts nothing in a single line', () => {
    expect(countEndings('no endings here')).toEqual({ crlf: 0, lf: 0 });
  });
});

describe('readShape', () => {
  it('reads a plain LF file', () => {
    expect(readShape('a\nb\n')).toEqual({ bom: false, eol: 'lf', finalNewline: true });
  });

  it('reads a CRLF file', () => {
    expect(readShape('a\r\nb\r\n')).toEqual({
      bom: false,
      eol: 'crlf',
      finalNewline: true,
    });
  });

  it('notices a missing final newline', () => {
    expect(readShape('a\nb').finalNewline).toBe(false);
    expect(readShape('a\r\nb').finalNewline).toBe(false);
  });

  it('notices a byte-order mark', () => {
    expect(readShape(`${BOM}a\n`).bom).toBe(true);
  });

  it('calls a file with no endings LF, which is what a new line would be', () => {
    expect(readShape('one line').eol).toBe('lf');
  });
});

describe('toEditor', () => {
  it('hands the box LF endings and no mark', () => {
    expect(toEditor(`${BOM}a\r\nb\r\n`)).toBe('a\nb\n');
  });

  it('leaves an LF file alone', () => {
    expect(toEditor('a\nb\n')).toBe('a\nb\n');
  });
});

describe('fromEditor', () => {
  it('puts a CRLF file back exactly as it was found', () => {
    const raw = `${BOM}first\r\nsecond\r\n`;
    expect(fromEditor(toEditor(raw), readShape(raw))).toBe(raw);
  });

  it('is a round trip for every shape it accepts', () => {
    for (const raw of [
      'a\nb\n',
      'a\nb',
      'a\r\nb\r\n',
      'a\r\nb',
      `${BOM}a\n`,
      `${BOM}a\r\nb\r\n`,
      'single line',
      '',
    ]) {
      expect(fromEditor(toEditor(raw), readShape(raw))).toBe(raw);
    }
  });

  it('keeps the endings of the file when the box hands back a paste', () => {
    // A paste can carry CRLF into the box even though the box reports LF.
    const shape = readShape('a\r\n');
    expect(fromEditor('one\r\ntwo\nthree', shape)).toBe('one\r\ntwo\r\nthree\r\n');
  });

  it('restores a trailing newline the user deleted', () => {
    // Losing it is a one-character diff on the last line for no reason.
    expect(fromEditor('a\nb', { bom: false, eol: 'lf', finalNewline: true })).toBe(
      'a\nb\n',
    );
  });

  it('does not grow one on a file that never had it', () => {
    expect(fromEditor('a\nb\n', { bom: false, eol: 'lf', finalNewline: false })).toBe(
      'a\nb',
    );
  });

  it('collapses several trailing newlines only when the file had none', () => {
    expect(fromEditor('a\n\n\n', { bom: false, eol: 'lf', finalNewline: false })).toBe(
      'a',
    );
    expect(fromEditor('a\n\n\n', { bom: false, eol: 'lf', finalNewline: true })).toBe(
      'a\n\n\n',
    );
  });

  it('leaves an emptied file empty rather than writing a lone newline', () => {
    expect(fromEditor('', { bom: false, eol: 'lf', finalNewline: true })).toBe('');
  });

  it('keeps the mark on a file that has one', () => {
    expect(fromEditor('a\n', { bom: true, eol: 'lf', finalNewline: true })).toBe(
      `${BOM}a\n`,
    );
  });
});

describe('hasMixedEndings', () => {
  it('is true only when both appear', () => {
    expect(hasMixedEndings('a\r\nb\n')).toBe(true);
    expect(hasMixedEndings('a\r\nb\r\n')).toBe(false);
    expect(hasMixedEndings('a\nb\n')).toBe(false);
    expect(hasMixedEndings('one line')).toBe(false);
  });
});

describe('refusalFor', () => {
  it('lets ordinary text through', () => {
    expect(refusalFor('a\nb\n', false)).toBeNull();
    expect(refusalFor('a\r\nb\r\n', false)).toBeNull();
    expect(refusalFor('', false)).toBeNull();
  });

  it('refuses bytes that did not decode, which the box cannot represent', () => {
    expect(refusalFor('good � bytes', true)).toMatch(/not valid UTF-8/);
  });

  it('refuses a binary file that happens to decode', () => {
    expect(refusalFor('PK\0\0', false)).toMatch(/NUL bytes/);
  });

  it('refuses mixed endings rather than rewriting every line', () => {
    expect(refusalFor('a\r\nb\n', false)).toMatch(/mixes CRLF and LF/);
  });

  it('reports the undecodable case first, since it is the worst one', () => {
    expect(refusalFor('a\r\nb\n\0', true)).toMatch(/not valid UTF-8/);
  });
});
