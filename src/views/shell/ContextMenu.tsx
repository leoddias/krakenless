/**
 * A context menu: a list of offers, anchored where the user right-clicked.
 *
 * Three things here are deliberate rather than incidental.
 *
 * **Unavailable items stay on the menu.** An item that disappears when it
 * cannot run reads as a feature the app does not have, and the user goes
 * looking for it in the command line. A disabled one carries the reason
 * underneath it, in the same words the rest of the app uses.
 *
 * **Disabled items keep their place in the keyboard order.** `aria-disabled`
 * rather than the `disabled` attribute: a button that cannot be focused is a
 * button whose explanation a screen-reader user never hears.
 *
 * **The menu is clamped into the viewport after it is measured.** A right-click
 * near the bottom of a tall commit list would otherwise open a menu whose last
 * items are off screen, which is exactly where the destructive ones sit.
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import styles from './ContextMenu.module.css';

export interface MenuItemSpec {
  id: string;
  label: string;
  /** Why the item cannot run right now; `null` or absent when it can. */
  disabled?: string | null;
  /** Absent for an item that only opens a submenu, or that cannot run. */
  onSelect?: () => void;
  submenu?: MenuItemSpec[];
}

/** Items are grouped; a rule is drawn between groups. */
export type MenuSection = MenuItemSpec[];

export interface ContextMenuProps {
  sections: MenuSection[];
  /** Viewport coordinates of the click that opened the menu. */
  x: number;
  y: number;
  /** Accessible name — what the menu is *about*, not what it contains. */
  label: string;
  onClose: () => void;
}

/** Gap kept between the menu and the window edge when it has to be moved. */
const EDGE_MARGIN = 4;

export function ContextMenu({
  sections,
  x,
  y,
  label,
  onClose,
}: ContextMenuProps): ReactNode {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  /** Id of the item whose submenu is open, or `null`. */
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  const baseId = useId();

  // The element that had focus when the menu opened, so it can be given back.
  // Without this a closed menu leaves focus on `document.body`, and the next
  // Tab restarts from the top of the window instead of the commit list.
  const returnFocusTo = useRef<Element | null>(null);
  useLayoutEffect(() => {
    returnFocusTo.current = document.activeElement;
    return () => {
      const target = returnFocusTo.current;
      if (target instanceof HTMLElement && target.isConnected) target.focus();
    };
  }, []);

  // Measured, then moved: the size is not known until it is in the document,
  // and guessing it would clamp menus that never needed clamping.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (menu === null) return;
    const { width, height } = menu.getBoundingClientRect();
    const maxLeft = window.innerWidth - width - EDGE_MARGIN;
    const maxTop = window.innerHeight - height - EDGE_MARGIN;
    setPosition({
      left: Math.max(EDGE_MARGIN, Math.min(x, maxLeft)),
      // A menu taller than the window pins to the top and scrolls inside.
      top: Math.max(EDGE_MARGIN, Math.min(y, maxTop)),
    });
  }, [x, y, sections]);

  // Focus the first item, so the keyboard works without a click first.
  useEffect(() => {
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, []);

  // Opening a submenu moves the cursor into it. Leaving focus on the parent
  // would make the next ArrowDown walk a list the user is no longer looking at.
  useEffect(() => {
    if (openSubmenu === null) return;
    menuRef.current
      ?.querySelector<HTMLElement>(`[data-submenu-of="${openSubmenu}"] [role="menuitem"]`)
      ?.focus();
  }, [openSubmenu]);

  // Anything outside the menu closes it — including a scroll or a resize, both
  // of which move the row the menu was opened from out from under it.
  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      if (menuRef.current?.contains(event.target as Node) === true) return;
      onClose();
    };
    // Capture phase, so the menu is already closed by the time anything inside
    // the app reacts to the same click — a menu still on screen over a panel
    // that has just changed under it names a commit that may no longer be
    // selected. The click itself is left to proceed.
    window.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const focusableItems = useCallback((): HTMLElement[] => {
    const menu = menuRef.current;
    if (menu === null) return [];
    // Only one level answers the arrow keys: the submenu when one is open, the
    // top level otherwise. Walking both at once puts the cursor somewhere the
    // eye is not.
    const scope =
      openSubmenu === null
        ? menu
        : menu.querySelector<HTMLElement>(`[data-submenu-of="${openSubmenu}"]`);
    return [...(scope?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  }, [openSubmenu]);

  const move = (delta: number): void => {
    const items = focusableItems();
    if (items.length === 0) return;
    const current = items.findIndex((item) => item === document.activeElement);
    const next = current === -1 ? 0 : (current + delta + items.length) % items.length;
    items[next]?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        if (openSubmenu !== null) {
          closeSubmenu(openSubmenu);
          return;
        }
        onClose();
        return;
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        return;
      case 'Home':
        event.preventDefault();
        focusableItems()[0]?.focus();
        return;
      case 'End': {
        event.preventDefault();
        const items = focusableItems();
        items[items.length - 1]?.focus();
        return;
      }
      case 'ArrowLeft':
        if (openSubmenu !== null) {
          event.preventDefault();
          closeSubmenu(openSubmenu);
        }
        return;
      default:
        return;
    }
  };

  function closeSubmenu(id: string): void {
    setOpenSubmenu(null);
    menuRef.current?.querySelector<HTMLElement>(`[data-item="${id}"]`)?.focus();
  }

  const choose = (item: MenuItemSpec): void => {
    if (typeof item.disabled === 'string') return;
    if (item.submenu !== undefined) {
      setOpenSubmenu(item.id);
      return;
    }
    if (item.onSelect === undefined) return;
    // The handler runs *before* the close, so that a host which reacts to
    // `onClose` — by dismissing itself when nothing was chosen, say — sees the
    // choice that was just made. Both land in one React batch either way, and
    // the menu unmounts before the frame is painted.
    item.onSelect();
    onClose();
  };

  return (
    <div
      className={styles.menu}
      role="menu"
      aria-label={label}
      aria-orientation="vertical"
      ref={menuRef}
      style={{ left: position.left, top: position.top }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      data-level="root"
    >
      {sections.map((section, index) => (
        <div
          key={section[0]?.id ?? index}
          role="group"
          className={index === 0 ? styles.group : styles.groupRuled}
        >
          {section.map((item) => (
            <Item
              key={item.id}
              item={item}
              baseId={baseId}
              submenuOpen={openSubmenu === item.id}
              onOpenSubmenu={() => setOpenSubmenu(item.id)}
              onChoose={choose}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function Item({
  item,
  baseId,
  submenuOpen,
  onOpenSubmenu,
  onChoose,
}: {
  item: MenuItemSpec;
  baseId: string;
  submenuOpen: boolean;
  onOpenSubmenu: () => void;
  onChoose: (item: MenuItemSpec) => void;
}): ReactNode {
  const reason = typeof item.disabled === 'string' ? item.disabled : null;
  const reasonId = `${baseId}-${item.id}-reason`;
  const hasSubmenu = item.submenu !== undefined;
  const anchor = useRef<HTMLButtonElement | null>(null);

  return (
    <>
      <button
        type="button"
        role="menuitem"
        ref={anchor}
        // Disabled *in role only*: the button keeps focus so the reason
        // underneath it can be announced.
        aria-disabled={reason === null ? undefined : true}
        aria-describedby={reason === null ? undefined : reasonId}
        {...(hasSubmenu ? { 'aria-haspopup': 'menu' as const } : {})}
        {...(hasSubmenu ? { 'aria-expanded': submenuOpen } : {})}
        data-item={item.id}
        className={reason === null ? styles.item : styles.itemDisabled}
        onClick={() => onChoose(item)}
        onKeyDown={(event) => {
          if (hasSubmenu && event.key === 'ArrowRight' && reason === null) {
            event.preventDefault();
            onOpenSubmenu();
          }
        }}
      >
        <span className={styles.label}>{item.label}</span>
        {hasSubmenu && (
          <span className={styles.chevron} aria-hidden="true">
            ›
          </span>
        )}
      </button>
      {reason !== null && (
        <p className={styles.reason} id={reasonId}>
          {reason}
        </p>
      )}
      {hasSubmenu && submenuOpen && (
        <Flyout anchor={anchor} label={item.label} itemId={item.id}>
          {(item.submenu ?? []).map((child) => (
            <Item
              key={child.id}
              item={child}
              baseId={baseId}
              submenuOpen={false}
              onOpenSubmenu={onOpenSubmenu}
              onChoose={onChoose}
            />
          ))}
        </Flyout>
      )}
    </>
  );
}

/**
 * A submenu, placed beside the item that opens it.
 *
 * Positioned `fixed` from the anchor's own rectangle rather than absolutely
 * inside the menu: the menu scrolls when it is taller than the window, and an
 * absolutely positioned child of a scrolling box is clipped at its edge — the
 * submenu would be cut off exactly when the window is small enough to need it.
 * It flips to the left of the menu when there is no room on the right.
 */
function Flyout({
  anchor,
  label,
  itemId,
  children,
}: {
  anchor: React.RefObject<HTMLButtonElement | null>;
  label: string;
  itemId: string;
  children: ReactNode;
}): ReactNode {
  const self = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const button = anchor.current;
    const menu = self.current;
    if (button === null || menu === null) return;
    const from = button.getBoundingClientRect();
    const size = menu.getBoundingClientRect();
    const rightward = from.right + size.width + EDGE_MARGIN <= window.innerWidth;
    setPosition({
      left: rightward
        ? from.right - 2
        : Math.max(EDGE_MARGIN, from.left - size.width + 2),
      top: Math.max(
        EDGE_MARGIN,
        Math.min(from.top - 4, window.innerHeight - size.height - EDGE_MARGIN),
      ),
    });
  }, [anchor]);

  return (
    <div
      className={styles.submenu}
      role="menu"
      aria-label={label}
      data-submenu-of={itemId}
      ref={self}
      // Hidden for the frame between mount and measurement, so it is never
      // seen at the top-left corner before it jumps into place.
      style={
        position === null
          ? { visibility: 'hidden', left: 0, top: 0 }
          : { left: position.left, top: position.top }
      }
    >
      {children}
    </div>
  );
}
