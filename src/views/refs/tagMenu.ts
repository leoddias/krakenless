/**
 * The model behind a tag row's context menu.
 *
 * Data rather than JSX, for the reason the commit menu is: every item is an
 * offer to run a git command and half of them must not be offered in some
 * states, so each refusal is a test rather than a rendering detail. Nothing is
 * hidden for being unavailable — a missing item reads as a feature this app
 * does not have, a disabled one with a reason reads as "not right now".
 *
 * The remote items are offered without the app knowing whether the remote has
 * that tag, which is the same bet `pushTagItems` makes in the commit menu:
 * asking costs a network round trip per row, git answers accurately for free,
 * and its refusal is reported as the failure it is.
 */

import type { Tag } from '../../git/types';

export type TagAction =
  | { kind: 'show' }
  | { kind: 'push'; remote: string }
  | { kind: 'delete' }
  | { kind: 'delete-remote'; remote: string }
  | { kind: 'copy'; text: string; what: string };

export interface TagMenuItem {
  id: string;
  label: string;
  /** Why this cannot run right now, or `null` when it can. */
  disabled: string | null;
  action?: TagAction;
}

export type TagMenuSection = TagMenuItem[];

export interface TagMenuContext {
  busy: boolean;
  /** Where a push would go, or `null` when the repository has no remote. */
  remote: string | null;
}

const BUSY = 'Another git operation is already running.';
const NO_REMOTE = 'This repository has no remote to push to.';

/** The whole menu for one tag, grouped into the sections it is drawn in. */
export function buildTagMenu(tag: Tag, context: TagMenuContext): TagMenuSection[] {
  const busy = context.busy ? BUSY : null;
  const remote = context.remote;
  const remoteReason = busy ?? (remote === null ? NO_REMOTE : null);

  return [
    [
      {
        // First, because it is what a click on the row already does, and the
        // menu is where a user looks to find out that it does it.
        id: 'tag-show',
        label: 'Show the commit',
        disabled: null,
        action: { kind: 'show' },
      },
    ],
    [
      {
        id: 'tag-push',
        label: remote === null ? 'Push tag' : `Push tag to ${remote}`,
        disabled: remoteReason,
        ...(remote === null || remoteReason !== null
          ? {}
          : { action: { kind: 'push' as const, remote } }),
      },
    ],
    [
      {
        id: 'tag-delete',
        label: 'Delete tag',
        disabled: busy,
        ...(busy === null ? { action: { kind: 'delete' as const } } : {}),
      },
      {
        id: 'tag-delete-remote',
        label: remote === null ? 'Delete tag on remote' : `Delete tag on ${remote}`,
        disabled: remoteReason,
        ...(remote === null || remoteReason !== null
          ? {}
          : { action: { kind: 'delete-remote' as const, remote } }),
      },
    ],
    [
      {
        id: 'tag-copy-name',
        label: 'Copy tag name',
        disabled: null,
        action: { kind: 'copy', text: tag.name, what: 'The tag name' },
      },
      {
        id: 'tag-copy-sha',
        label: 'Copy commit sha',
        disabled: null,
        // The commit, not the tag object: it is what the rest of the app shows
        // for this row, and what anyone pasting it into a command means.
        action: { kind: 'copy', text: tag.oid, what: 'The commit sha' },
      },
    ],
  ];
}

/** What a tag row says about itself under its name. */
export function tagSummary(tag: Tag): string {
  const kind = tag.annotated ? 'Annotated tag' : 'Lightweight tag';
  const subject = tag.annotated && tag.subject.length > 0 ? ` — ${tag.subject}` : '';
  return `${kind} ${tag.name}${subject}`;
}
