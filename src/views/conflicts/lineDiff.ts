/**
 * Line matching for the conflict resolver: Myers' O(ND) diff, linear space.
 *
 * The cost is proportional to the size of the files times the number of lines
 * that *differ*, not to the product of the two sizes. A locale file of fifty
 * thousand lines where two branches touched a dozen keys is a few hundred
 * thousand steps — milliseconds — where the full LCS table it replaces was two
 * and a half billion cells. That is the same algorithm family VS Code and git
 * itself use, and it gives the same answer the table did: a longest common
 * subsequence, so the agreed runs are as long as they can be.
 *
 * Three things keep it cheap:
 *
 * - every line is interned to an integer once, so the inner loop compares
 *   numbers in typed arrays, never strings;
 * - the common prefix and suffix are matched before any search, which is most
 *   of a file in a typical conflict;
 * - the search runs on a work budget. When two regions are so different that
 *   finding the optimal matching would cost more than the budget, that region is
 *   left unmatched — it becomes one larger block with both sides shown. That is
 *   coarser, never wrong: a line that is not matched is only ever *asked about*,
 *   and nothing is merged automatically on the strength of a guess.
 */

/**
 * Steps of the search the whole diff may take before regions are left unmatched.
 *
 * One budget for the whole file, not one per region: that is what bounds the
 * worst case. Once it is spent, every region not yet searched keeps only its
 * matching ends, so a pathological file can show one large block where a
 * perfect diff would show several. A real conflict never comes near it — the
 * 5,000-line locale file that prompted this spends well under 1% of it.
 */
export const WORK_BUDGET = 40_000_000;

/** Every distinct line as a small integer, shared by all the files it is given. */
export function intern(...files: string[][]): Int32Array[] {
  const ids = new Map<string, number>();
  return files.map((lines) => {
    const out = new Int32Array(lines.length);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] as string;
      let id = ids.get(line);
      if (id === undefined) {
        id = ids.size;
        ids.set(line, id);
      }
      out[i] = id;
    }
    return out;
  });
}

interface Budget {
  left: number;
}

/**
 * For every line of `a`, the line of `b` it is matched to, or -1.
 *
 * Monotonic — a later line of `a` never matches an earlier line of `b` — and
 * every match pairs equal lines.
 */
export function matchLines(a: string[], b: string[], budget = WORK_BUDGET): Int32Array {
  const [x, y] = intern(a, b) as [Int32Array, Int32Array];
  const map = new Int32Array(a.length).fill(-1);
  diffRange(x, 0, x.length, y, 0, y.length, map, { left: budget });
  return map;
}

function diffRange(
  a: Int32Array,
  aLo: number,
  aHi: number,
  b: Int32Array,
  bLo: number,
  bHi: number,
  map: Int32Array,
  budget: Budget,
): void {
  // Recursion is on the halves of the edit script, so its depth is log D; the
  // loop is only here to strip what both ends of a range agree on.
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
    map[aLo] = bLo;
    aLo += 1;
    bLo += 1;
  }
  while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) {
    aHi -= 1;
    bHi -= 1;
    map[aHi] = bHi;
  }
  if (aLo === aHi || bLo === bHi) return;

  const snake = middleSnake(a, aLo, aHi, b, bLo, bHi, budget);
  if (snake === null) return; // Over budget: this region stays unmatched.
  const [sx, sy, ex, ey] = snake;
  diffRange(a, aLo, sx, b, bLo, sy, map, budget);
  for (let i = sx, j = sy; i < ex; i += 1, j += 1) map[i] = j;
  diffRange(a, ex, aHi, b, ey, bHi, map, budget);
}

/**
 * The middle snake of Myers (1986): a run of matching lines that the optimal
 * edit path crosses halfway through its edits, found by searching forward from
 * the start and backward from the end until the two frontiers overlap.
 *
 * Returns absolute `[startA, startB, endA, endB]`, or null when the budget ran
 * out first. The callers have stripped the common prefix and suffix, so both
 * ranges are non-empty and differ at both ends, which makes D at least 2 and
 * each half strictly smaller than the whole.
 */
function middleSnake(
  a: Int32Array,
  aLo: number,
  aHi: number,
  b: Int32Array,
  bLo: number,
  bHi: number,
  budget: Budget,
): [number, number, number, number] | null {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const delta = n - m;
  const odd = (delta & 1) !== 0;
  const max = Math.ceil((n + m) / 2);
  const off = max + 1;
  // Forward: furthest x reached on each diagonal k = x - y.
  const vf = new Int32Array(2 * max + 3);
  // Backward: furthest distance from the end on each reversed diagonal c, which
  // is forward diagonal delta - c.
  const vb = new Int32Array(2 * max + 3);

  for (let d = 0; d <= max; d += 1) {
    budget.left -= 2 * d + 1;
    if (budget.left < 0) return null;

    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (vf[off + k - 1] as number) < (vf[off + k + 1] as number))
          ? (vf[off + k + 1] as number)
          : (vf[off + k - 1] as number) + 1;
      let y = x - k;
      const x0 = x;
      const y0 = y;
      while (x < n && y < m && a[aLo + x] === b[bLo + y]) {
        x += 1;
        y += 1;
      }
      budget.left -= x - x0;
      vf[off + k] = x;
      const c = delta - k;
      if (odd && c >= -(d - 1) && c <= d - 1 && x + (vb[off + c] as number) >= n) {
        return [aLo + x0, bLo + y0, aLo + x, bLo + y];
      }
    }

    for (let c = -d; c <= d; c += 2) {
      let x =
        c === -d || (c !== d && (vb[off + c - 1] as number) < (vb[off + c + 1] as number))
          ? (vb[off + c + 1] as number)
          : (vb[off + c - 1] as number) + 1;
      let y = x - c;
      const x0 = x;
      const y0 = y;
      while (x < n && y < m && a[aHi - 1 - x] === b[bHi - 1 - y]) {
        x += 1;
        y += 1;
      }
      budget.left -= x - x0;
      vb[off + c] = x;
      const k = delta - c;
      if (!odd && k >= -d && k <= d && x + (vf[off + k] as number) >= n) {
        return [aHi - x, bHi - y, aHi - x0, bHi - y0];
      }
    }
  }
  return null;
}
