/**
 * The branch / worktree picker in the toolbar.
 *
 * One list, two groups, because they answer one question — "where do I want to
 * be working?" — with two different kinds of answer. Picking a **branch**
 * checks it out here, in this window, moving these files. Picking a
 * **worktree** does not touch this checkout at all: it opens that directory in
 * a tab, the same way the history's WIP row does.
 *
 * The grouping is what keeps that honest. A worktree entry says which branch is
 * open over there, so the one thing a user must never do — expect a checkout
 * and get a tab, or the reverse — is answered before the click.
 *
 * A branch already checked out *somewhere* cannot be checked out here: git
 * refuses, because two worktrees may never share a branch. That refusal is
 * shown as the reason on a disabled item rather than delivered as an error
 * after the fact, and the worktree that holds it is named.
 */

import { useState, type ReactNode } from 'react';
import { switchTo } from '../../state/actions';
import { useAppState, useStore } from '../../state/hooks';
import { requestOpenRepository } from '../../state/openRequests';
import { isBusy } from '../../state/store';
import { buildCheckoutMenu, checkoutLabel, type CheckoutChoice } from './checkoutMenu';
import { ContextMenu, type MenuSection } from './ContextMenu';
import { ChevronDownIcon } from './icons';
import styles from './CheckoutPicker.module.css';

export function CheckoutPicker(): ReactNode {
  const store = useStore();
  const status = useAppState((state) => state.status);
  const branches = useAppState((state) => state.branches);
  const worktrees = useAppState((state) => state.worktrees);
  const busy = useAppState(isBusy);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  const shown = checkoutLabel(status);

  const menu = buildCheckoutMenu({
    branches,
    worktrees,
    busy,
    onCheckout: (name) => void switchTo(store, name),
    onOpen: (path) => requestOpenRepository(path),
  });

  const toSection = (choices: CheckoutChoice[]): MenuSection =>
    choices.map((choice) => ({
      id: choice.id,
      label: choice.label,
      disabled: choice.disabled,
      ...(choice.choose === undefined
        ? {}
        : {
            onSelect: () => {
              choice.choose?.();
              setAnchor(null);
            },
          }),
    }));

  const sections: MenuSection[] = [];
  if (menu.branches.length > 0) sections.push(toSection(menu.branches));
  if (menu.worktrees.length > 0) sections.push(toSection(menu.worktrees));
  if (sections.length === 0) {
    sections.push([
      { id: 'empty', label: 'No branches read yet', disabled: 'Nothing to show yet.' },
    ]);
  }

  return (
    <>
      <button
        type="button"
        className={styles.button}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        title={
          status.state === 'error'
            ? status.message
            : 'Switch branch, or open another worktree'
        }
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          // Anchored under the button rather than at the pointer: this is a
          // dropdown, and it must open in the same place whether it was reached
          // by mouse or by keyboard.
          setAnchor({ x: rect.left, y: rect.bottom });
        }}
      >
        <span className={shown.muted ? `${styles.value} ${styles.muted}` : styles.value}>
          {shown.text}
        </span>
        <ChevronDownIcon size={12} />
      </button>
      {anchor !== null && (
        <ContextMenu
          sections={sections}
          x={anchor.x}
          y={anchor.y}
          label="Branches and worktrees"
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}
