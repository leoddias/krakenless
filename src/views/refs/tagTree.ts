/**
 * A list of tags arranged by the prefixes they share.
 *
 * Tags are named on a different pattern from branches, which is why they get
 * their own builder rather than `views/shell/pathTree.ts`. A branch is
 * `feat/x`, carved up by slashes; a release tag is `release-1.0.4`, `v2.0.0`,
 * `2026.09-rc1` — the separator is a hyphen or an underscore as often as a
 * slash, and just as often it is the seam between a word and the number after
 * it. Splitting tags on slashes alone leaves a hundred `release-…` rows saying
 * `release-` a hundred times, which is the thing a tree is for.
 *
 * Pure, and separate from the panel, so the rules can be asserted directly.
 * Three of them do the work:
 *
 *   - a name is cut at `/`, `-`, `_`, and where letters run into digits, so
 *     `release-1.0.4` and `v2.0.0` both have a first segment worth grouping by;
 *   - a group is only made when **two or more** tags share that first segment,
 *     because a group of one is an indent that hides a name instead of
 *     shortening it;
 *   - only the one separator that made the cut is dropped, so what is left of
 *     a name keeps its own (`release-1.0-rc1` under `release` reads `1.0-rc1`).
 *
 * Order is the order the tags arrive in — git sorts them by version, newest
 * first — with groups before loose tags, each group where its first member was.
 */

import type { Tag } from '../../git/types';

export type TagNode =
  | {
      kind: 'group';
      /** The segment shown on the row. */
      name: string;
      /**
       * Identity of this group in the tree, its ancestors included — what a
       * fold is remembered under. Built from the segments rather than sliced
       * out of a tag name, because the separators that were cut are not all
       * the same character and one of them is not a character at all.
       */
      key: string;
      children: TagNode[];
    }
  | {
      kind: 'tag';
      /** What the row prints: the name with its groups' segments taken off. */
      label: string;
      tag: Tag;
    };

/**
 * The first segment of a name, and what follows it.
 *
 * `null` when the name is one segment: there is nothing to group it by. Only
 * the separator that made the cut is dropped; the rest of the name comes back
 * untouched.
 */
export function splitTagName(name: string): { head: string; rest: string } | null {
  // A separator, or the seam between letters and digits (`v2.0.0` → `v`,
  // `2.0.0`), which is how the commonest tag names in the world are built.
  const at = /[/\-_]|(?<=[A-Za-z])(?=\d)/.exec(name);
  if (at === null || at.index === 0) return null;

  const head = name.slice(0, at.index);
  const rest = name.slice(at.index + at[0].length);
  if (head.length === 0 || rest.length === 0) return null;
  return { head, rest };
}

/** Arranges tags into the rows the panel draws. */
export function buildTagTree(tags: readonly Tag[]): TagNode[] {
  return build(
    tags.map((tag) => ({ rest: tag.name, tag })),
    '',
  );
}

/** One tag as it stands at some depth: what is left of its name, and itself. */
interface Pending {
  rest: string;
  tag: Tag;
}

function build(items: readonly Pending[], parentKey: string): TagNode[] {
  // Insertion-ordered: `Map` keeps the order the first member arrived in, so
  // the list stays in the order git sorted it rather than an alphabetical one
  // nobody asked for.
  const groups = new Map<string, Pending[]>();
  const loose: Pending[] = [];

  for (const item of items) {
    const split = splitTagName(item.rest);
    if (split === null) {
      loose.push(item);
      continue;
    }
    const bucket = groups.get(split.head);
    if (bucket === undefined) groups.set(split.head, [item]);
    else bucket.push(item);
  }

  const nodes: TagNode[] = [];
  for (const [head, members] of groups) {
    // A group of one is an indent that hides a name instead of shortening it,
    // so its tag goes back to being a row of its own, whole name and all.
    const only = members[0];
    if (members.length < 2 && only !== undefined) {
      loose.push(only);
      continue;
    }
    const key = parentKey.length === 0 ? head : `${parentKey}/${head}`;
    nodes.push({
      kind: 'group',
      name: head,
      key,
      children: build(
        members.map((member) => ({
          // Re-split rather than kept from above: the bucket holds the items as
          // they stood *before* the cut, so a group that turns out to have one
          // member can still put its whole name back on the row.
          rest: splitTagName(member.rest)?.rest ?? member.rest,
          tag: member.tag,
        })),
        key,
      ),
    });
  }

  for (const item of loose) nodes.push({ kind: 'tag', label: item.rest, tag: item.tag });
  return nodes;
}

/** Every group's key in the tree, for "collapse all" and its inverse. */
export function tagGroupKeys(nodes: readonly TagNode[]): string[] {
  return nodes.flatMap((node) =>
    node.kind === 'group' ? [node.key, ...tagGroupKeys(node.children)] : [],
  );
}
