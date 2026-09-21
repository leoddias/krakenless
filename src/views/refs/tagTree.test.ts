import { describe, expect, it } from 'vitest';
import { buildTagTree, splitTagName, tagGroupKeys, type TagNode } from './tagTree';
import type { Tag } from '../../git/types';

function tag(name: string): Tag {
  return {
    name,
    oid: 'a'.repeat(40),
    object: 'a'.repeat(40),
    annotated: false,
    date: '2026-09-19T10:00:00+00:00',
    subject: '',
  };
}

/** The tree as `name > name > …` lines, which is what the rows look like. */
function shape(nodes: readonly TagNode[], depth = 0): string[] {
  return nodes.flatMap((node) =>
    node.kind === 'group'
      ? [`${'  '.repeat(depth)}${node.name}/`, ...shape(node.children, depth + 1)]
      : [`${'  '.repeat(depth)}${node.label}`],
  );
}

describe('splitTagName', () => {
  it('cuts at a slash, a hyphen or an underscore', () => {
    expect(splitTagName('release-1.0.4')).toEqual({ head: 'release', rest: '1.0.4' });
    expect(splitTagName('release/1.0.4')).toEqual({ head: 'release', rest: '1.0.4' });
    expect(splitTagName('release_1.0.4')).toEqual({ head: 'release', rest: '1.0.4' });
  });

  it('cuts where letters run into digits, which is how v-tags are built', () => {
    expect(splitTagName('v2.0.0')).toEqual({ head: 'v', rest: '2.0.0' });
    expect(splitTagName('rc1')).toEqual({ head: 'rc', rest: '1' });
  });

  it('cuts once, leaving the rest of the name as it was', () => {
    // The second hyphen belongs to the name below the group, not to the cut.
    expect(splitTagName('release-1.0-rc1')).toEqual({ head: 'release', rest: '1.0-rc1' });
  });

  it('has nothing to say about a name with no seam in it', () => {
    expect(splitTagName('nightly')).toBeNull();
    expect(splitTagName('2026.09.19')).toBeNull();
  });

  it('refuses a cut at the very start or end, which would name nothing', () => {
    expect(splitTagName('-v1.0')).toBeNull();
    expect(splitTagName('nightly-')).toBeNull();
  });

  it('takes the first seam, wherever it is', () => {
    // `v1.0-` is cut at the `v`, not at the trailing hyphen: the seam between
    // letters and digits comes first, and what follows it is a real name.
    expect(splitTagName('v1.0-')).toEqual({ head: 'v', rest: '1.0-' });
  });
});

describe('buildTagTree', () => {
  it('groups the tags that share a first segment', () => {
    const nodes = buildTagTree(
      ['release-1.0.4', 'release-1.0.3', 'release-1.0.2'].map(tag),
    );
    expect(shape(nodes)).toEqual(['release/', '  1.0.4', '  1.0.3', '  1.0.2']);
  });

  it('groups v-tags by the letter in front of the number', () => {
    expect(shape(buildTagTree(['v2.0.0', 'v1.9.0'].map(tag)))).toEqual([
      'v/',
      '  2.0.0',
      '  1.9.0',
    ]);
  });

  it('leaves a tag that shares its prefix with nobody as a row of its own', () => {
    // A group of one indents a name without shortening it, and hides it behind
    // a fold for nothing.
    const nodes = buildTagTree(['release-1.0.4', 'release-1.0.3', 'nightly'].map(tag));
    expect(shape(nodes)).toEqual(['release/', '  1.0.4', '  1.0.3', 'nightly']);
  });

  it('keeps the whole name on a row that did not end up grouped', () => {
    // `hotfix-1` was split to see whether it had company; it had none, so the
    // row says what the tag is called and not `1`.
    const nodes = buildTagTree(['release-1.0.4', 'release-1.0.3', 'hotfix-1'].map(tag));
    expect(shape(nodes)).toEqual(['release/', '  1.0.4', '  1.0.3', 'hotfix-1']);
  });

  it('groups again inside a group when the names go on sharing', () => {
    // Every level applies the same rule to what is left of the name, so two
    // release candidates end up under the `rc` they share and the release that
    // has no company stays a row.
    const nodes = buildTagTree(
      ['release-1.0-rc1', 'release-1.0-rc2', 'release-2.0'].map(tag),
    );
    expect(shape(nodes)).toEqual([
      'release/',
      '  1.0/',
      '    rc/',
      '      1',
      '      2',
      '  2.0',
    ]);
  });

  it('draws groups before loose tags, in the order git listed them', () => {
    // git sorts by version, newest first; an alphabetical reshuffle here would
    // put an old release at the top of the panel.
    const nodes = buildTagTree(
      ['nightly', 'v2.0.0', 'v1.9.0', 'release-1.0.4', 'release-1.0.3'].map(tag),
    );
    expect(shape(nodes)).toEqual([
      'v/',
      '  2.0.0',
      '  1.9.0',
      'release/',
      '  1.0.4',
      '  1.0.3',
      'nightly',
    ]);
  });

  it('keeps every tag exactly once, whatever the shape', () => {
    const names = ['v1.0', 'v2.0', 'release-1', 'release-2', 'nightly', 'odd_one_out'];
    const nodes = buildTagTree(names.map(tag));
    const seen: string[] = [];
    const walk = (list: readonly TagNode[]): void => {
      for (const node of list) {
        if (node.kind === 'group') walk(node.children);
        else seen.push(node.tag.name);
      }
    };
    walk(nodes);
    expect(seen.sort()).toEqual([...names].sort());
  });

  it('is empty for a repository with no tags', () => {
    expect(buildTagTree([])).toEqual([]);
  });
});

describe('tagGroupKeys', () => {
  it('names every group, nested ones included', () => {
    const nodes = buildTagTree(
      ['release-1.0-rc1', 'release-1.0-rc2', 'release-2.0', 'v1.0', 'v2.0'].map(tag),
    );
    expect(tagGroupKeys(nodes)).toEqual([
      'release',
      'release/1.0',
      'release/1.0/rc',
      'v',
    ]);
  });

  it('keys a nested group under its ancestors, so two `1`s are not one fold', () => {
    const nodes = buildTagTree(
      ['release-1-a', 'release-1-b', 'beta-1-a', 'beta-1-b'].map(tag),
    );
    expect(new Set(tagGroupKeys(nodes)).size).toBe(tagGroupKeys(nodes).length);
  });
});
