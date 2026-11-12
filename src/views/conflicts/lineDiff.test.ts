import { describe, expect, it } from 'vitest';

import { intern, matchLines } from './lineDiff';

/** The exact LCS length, by the quadratic table the diff replaced. */
function lcsLength(a: string[], b: string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      row[j] =
        a[i - 1] === b[j - 1]
          ? (prev[j - 1] as number) + 1
          : Math.max(prev[j] as number, row[j - 1] as number);
    }
    prev = row;
  }
  return prev[b.length] as number;
}

/** Every match pairs equal lines, in order, and no line of b is used twice. */
function expectValid(a: string[], b: string[], map: Int32Array): number {
  let last = -1;
  let count = 0;
  map.forEach((j, i) => {
    if (j === -1) return;
    expect(j).toBeGreaterThan(last);
    expect(a[i]).toBe(b[j]);
    last = j;
    count += 1;
  });
  return count;
}

/** A small deterministic generator, so a failure reproduces. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

describe('intern', () => {
  it('gives equal lines one id across every file it is handed', () => {
    const [a, b] = intern(['x', 'y', 'x'], ['y', 'z']) as [Int32Array, Int32Array];
    expect(a[0]).toBe(a[2]);
    expect(a[1]).toBe(b[0]);
    expect(b[1]).not.toBe(a[0]);
  });
});

describe('matchLines', () => {
  it('matches identical files line for line', () => {
    const lines = ['a', 'b', 'c'];
    expect(Array.from(matchLines(lines, lines))).toEqual([0, 1, 2]);
  });

  it('handles either side being empty', () => {
    expect(Array.from(matchLines([], ['a']))).toEqual([]);
    expect(Array.from(matchLines(['a', 'b'], []))).toEqual([-1, -1]);
  });

  it('leaves an inserted and a deleted line unmatched, and nothing else', () => {
    expect(Array.from(matchLines(['a', 'b', 'c'], ['a', 'x', 'b', 'c']))).toEqual([
      0, 2, 3,
    ]);
    expect(Array.from(matchLines(['a', 'b', 'c'], ['a', 'c']))).toEqual([0, -1, 1]);
  });

  it('finds a longest common subsequence, as the quadratic table did', () => {
    const next = rng(7);
    for (let round = 0; round < 300; round += 1) {
      const alphabet = 2 + Math.floor(next() * 5);
      const make = (): string[] =>
        Array.from({ length: Math.floor(next() * 40) }, () =>
          String.fromCharCode(97 + Math.floor(next() * alphabet)),
        );
      const a = make();
      const b = make();
      const map = matchLines(a, b);
      expect(expectValid(a, b, map)).toBe(lcsLength(a, b));
    }
  });

  it('diffs a large file with a few edits in well under a second', () => {
    const a = Array.from(
      { length: 60_000 },
      (_, i) => `  "key.${String(i)}": "value ${String(i)}",`,
    );
    const b = [...a];
    for (let i = 500; i < b.length; i += 5_000) b[i] = `${b[i] as string} edited`;
    b.splice(30_000, 0, '  "new.key": "added",');
    b.splice(45_000, 3);

    const started = performance.now();
    const map = matchLines(a, b);
    const took = performance.now() - started;

    expect(expectValid(a, b, map)).toBe(a.length - 12 - 3);
    expect(took).toBeLessThan(1_000);
  });

  it('leaves a region unmatched rather than overrun its budget', () => {
    // Nothing in common in the middle; a budget too small to search it.
    const a = ['top', ...Array.from({ length: 200 }, (_, i) => `a${String(i)}`), 'end'];
    const b = [
      'top',
      ...Array.from({ length: 200 }, (_, i) => `b${String(i % 7)}`),
      'end',
    ];
    const map = matchLines(a, b, 10);
    expectValid(a, b, map);
    // The agreed ends are still found: they never cost any search.
    expect(map[0]).toBe(0);
    expect(map[a.length - 1]).toBe(b.length - 1);
  });

  it('still finds the shared lines inside a heavily rewritten file, given the budget', () => {
    const next = rng(11);
    const a = Array.from({ length: 3_000 }, () => `l${String(Math.floor(next() * 50))}`);
    const b = Array.from({ length: 3_000 }, () => `l${String(Math.floor(next() * 50))}`);
    expect(expectValid(a, b, matchLines(a, b))).toBe(lcsLength(a, b));
  });
});
