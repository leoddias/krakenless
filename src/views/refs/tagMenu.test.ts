import { describe, expect, it } from 'vitest';
import { buildTagMenu, tagSummary, type TagMenuItem } from './tagMenu';
import type { Tag } from '../../git/types';

function tag(overrides: Partial<Tag> & { name: string }): Tag {
  return {
    oid: 'a'.repeat(40),
    object: 'a'.repeat(40),
    annotated: false,
    date: '2026-09-19T10:00:00+00:00',
    subject: '',
    ...overrides,
  };
}

function flat(sections: TagMenuItem[][]): TagMenuItem[] {
  return sections.flat();
}

function item(sections: TagMenuItem[][], id: string): TagMenuItem {
  const found = flat(sections).find((one) => one.id === id);
  if (found === undefined) throw new Error(`no item ${id}`);
  return found;
}

describe('buildTagMenu', () => {
  const v1 = tag({ name: 'v1.0' });

  it('offers reading the commit first, which is what the row already does', () => {
    const sections = buildTagMenu(v1, { busy: false, remote: 'origin' });
    expect(sections[0]?.[0]?.id).toBe('tag-show');
  });

  it('names the remote in both of the items that reach it', () => {
    const sections = buildTagMenu(v1, { busy: false, remote: 'upstream' });
    expect(item(sections, 'tag-push').label).toBe('Push tag to upstream');
    expect(item(sections, 'tag-delete-remote').label).toBe('Delete tag on upstream');
  });

  it('disables the remote items with a reason when there is no remote', () => {
    const sections = buildTagMenu(v1, { busy: false, remote: null });
    for (const id of ['tag-push', 'tag-delete-remote']) {
      expect(item(sections, id).disabled).toContain('no remote');
      expect(item(sections, id).action).toBeUndefined();
    }
    // The local delete is unaffected: it needs nobody's network.
    expect(item(sections, 'tag-delete').action).toEqual({ kind: 'delete' });
  });

  it('refuses every git command while one is running, and says which', () => {
    const sections = buildTagMenu(v1, { busy: true, remote: 'origin' });
    for (const id of ['tag-push', 'tag-delete', 'tag-delete-remote']) {
      expect(item(sections, id).disabled).toContain('already running');
      expect(item(sections, id).action).toBeUndefined();
    }
  });

  it('keeps reading and copying available while git is busy', () => {
    // Neither runs a command, and a menu that greys out "copy" while a fetch
    // is in flight teaches the user that the app is stuck.
    const sections = buildTagMenu(v1, { busy: true, remote: 'origin' });
    for (const id of ['tag-show', 'tag-copy-name', 'tag-copy-sha']) {
      expect(item(sections, id).disabled).toBeNull();
    }
  });

  it('copies the commit an annotated tag points into, not the tag object', () => {
    const annotated = tag({
      name: 'v2.0',
      annotated: true,
      oid: 'c'.repeat(40),
      object: 'd'.repeat(40),
    });
    const sections = buildTagMenu(annotated, { busy: false, remote: 'origin' });
    expect(item(sections, 'tag-copy-sha').action).toEqual({
      kind: 'copy',
      text: 'c'.repeat(40),
      what: 'The commit sha',
    });
  });

  it('never offers a delete without a confirmation behind it', () => {
    // The action carries no reason: the panel mints that from the question it
    // shows, which is what the git layer validates.
    const sections = buildTagMenu(v1, { busy: false, remote: 'origin' });
    expect(item(sections, 'tag-delete').action).toEqual({ kind: 'delete' });
    expect(item(sections, 'tag-delete-remote').action).toEqual({
      kind: 'delete-remote',
      remote: 'origin',
    });
  });
});

describe('tagSummary', () => {
  it('says which kind of tag it is', () => {
    expect(tagSummary(tag({ name: 'v1.0' }))).toBe('Lightweight tag v1.0');
    expect(tagSummary(tag({ name: 'v2.0', annotated: true }))).toBe('Annotated tag v2.0');
  });

  it('carries an annotated tag’s message, which is the point of annotating', () => {
    expect(tagSummary(tag({ name: 'v2.0', annotated: true, subject: 'ship it' }))).toBe(
      'Annotated tag v2.0 — ship it',
    );
  });
});
