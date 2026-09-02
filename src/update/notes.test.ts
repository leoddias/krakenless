import { describe, expect, it } from 'vitest';
import { plainNotes } from './notes';

describe('plainNotes', () => {
  it('strips bold markers that would otherwise be read as punctuation', () => {
    expect(plainNotes('**Pre-alpha.** Not dogfooded yet.')).toBe(
      'Pre-alpha. Not dogfooded yet.',
    );
    expect(plainNotes('__Pre-alpha.__ Not dogfooded.')).toBe('Pre-alpha. Not dogfooded.');
  });

  it('strips bold that spans a line break', () => {
    expect(plainNotes('**Pre-alpha.\nStill early.**')).toBe('Pre-alpha.\nStill early.');
  });

  it('strips heading hashes but keeps the words', () => {
    expect(plainNotes('## What changed\nA thing.')).toBe('What changed\nA thing.');
  });

  it('keeps a bullet marker, which a lone asterisk usually is', () => {
    expect(plainNotes('* one\n* two')).toBe('* one\n* two');
  });

  it('keeps link text and drops the URL', () => {
    expect(plainNotes('See [the README](https://example.test/a/b) for details.')).toBe(
      'See the README for details.',
    );
  });

  it('collapses runs of blank lines', () => {
    expect(plainNotes('one\n\n\n\ntwo')).toBe('one\n\ntwo');
  });

  it('trims surrounding whitespace', () => {
    expect(plainNotes('\n\n  notes  \n\n')).toBe('notes');
  });

  it('reads the real v0.1.11 release body the way a person would', () => {
    const body =
      '**Pre-alpha.** Krakenless has not been dogfooded yet — see the\n' +
      'README for what works and what does not.\n\n' +
      'These installers are **unsigned**. Windows SmartScreen will say the\n' +
      'publisher is unknown.';
    expect(plainNotes(body)).toBe(
      'Pre-alpha. Krakenless has not been dogfooded yet — see the\n' +
        'README for what works and what does not.\n\n' +
        'These installers are unsigned. Windows SmartScreen will say the\n' +
        'publisher is unknown.',
    );
  });

  it.each([
    ['', 'empty'],
    ['   \n\n  ', 'only whitespace'],
    ['****', 'only markers'],
  ])('returns nothing for %j (%s), so the dialog shows no notes box', (text) => {
    expect(plainNotes(text)).toBe('');
  });

  it.each([null, undefined, 42, {}])('returns nothing for the non-string %j', (value) => {
    expect(plainNotes(value)).toBe('');
  });

  it('cuts long notes at a line boundary, never mid-sentence', () => {
    const line = 'a'.repeat(100);
    const long = Array.from({ length: 100 }, () => line).join('\n');

    const result = plainNotes(long);

    expect(result.length).toBeLessThan(long.length);
    expect(result.endsWith('\n…')).toBe(true);
    // Every line that survived is a whole line.
    for (const kept of result.slice(0, -2).split('\n')) {
      expect(kept).toBe(line);
    }
  });

  it('does not mark short notes as truncated', () => {
    expect(plainNotes('short').endsWith('…')).toBe(false);
  });

  it('still returns something when the first line is longer than the limit', () => {
    expect(plainNotes('b'.repeat(9000))).not.toBe('');
  });
});
