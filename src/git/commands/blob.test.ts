import { describe, expect, it } from 'vitest';
import { buildBlobSpec } from './blob';

const OID = 'a'.repeat(40);

describe('buildBlobSpec', () => {
  it('names the index, HEAD, a commit and its first parent', () => {
    expect(buildBlobSpec({ kind: 'index' }, 'img/a.png')).toBe(':img/a.png');
    expect(buildBlobSpec({ kind: 'head' }, 'img/a.png')).toBe('HEAD:img/a.png');
    expect(buildBlobSpec({ kind: 'commit', oid: OID }, 'a.png')).toBe(`${OID}:a.png`);
    expect(buildBlobSpec({ kind: 'commit', oid: OID, parent: true }, 'a.png')).toBe(
      `${OID}^:a.png`,
    );
  });

  it('keeps spaces and colons inside the path, which git reads after the first colon', () => {
    expect(buildBlobSpec({ kind: 'head' }, 'my dir/a:b.png')).toBe('HEAD:my dir/a:b.png');
  });

  it('refuses an abbreviated or non-hex oid — a spec must name one exact commit', () => {
    expect(() => buildBlobSpec({ kind: 'commit', oid: 'abc1234' }, 'a.png')).toThrow();
    expect(() => buildBlobSpec({ kind: 'commit', oid: 'main' }, 'a.png')).toThrow();
    expect(() =>
      buildBlobSpec({ kind: 'commit', oid: `--output=${OID}` }, 'a.png'),
    ).toThrow();
  });

  it('refuses paths that are empty, absolute or climb out', () => {
    for (const path of [
      '',
      '/etc/passwd',
      'C:/x.png',
      '../a.png',
      'a/../../b.png',
      'a\0b',
    ]) {
      expect(() => buildBlobSpec({ kind: 'head' }, path)).toThrow();
    }
  });
});
