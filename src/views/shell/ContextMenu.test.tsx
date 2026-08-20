import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextMenu, type MenuSection } from './ContextMenu';

function sections(overrides: Partial<Record<string, unknown>> = {}): MenuSection[] {
  const onCheckout = (overrides.onCheckout ?? (() => {})) as () => void;
  const onSoft = (overrides.onSoft ?? (() => {})) as () => void;
  return [
    [{ id: 'checkout', label: 'Checkout this commit', onSelect: onCheckout }],
    [
      { id: 'copy', label: 'Copy commit sha', onSelect: () => {} },
      {
        id: 'blocked',
        label: 'Rebase main onto this commit',
        disabled: 'HEAD is detached.',
      },
      {
        id: 'reset',
        label: 'Reset main to this commit',
        submenu: [
          { id: 'soft', label: 'Soft', onSelect: onSoft },
          { id: 'hard', label: 'Hard', onSelect: () => {} },
        ],
      },
    ],
  ];
}

function renderMenu(overrides: Partial<Record<string, unknown>> = {}) {
  const onClose = vi.fn();
  render(
    <ContextMenu
      sections={sections(overrides)}
      x={10}
      y={10}
      label="Actions for commit a1b2c3d"
      onClose={onClose}
    />,
  );
  return { onClose };
}

function items(): HTMLElement[] {
  return screen.getAllByRole('menuitem');
}

afterEach(cleanup);

describe('ContextMenu', () => {
  it('is named after what it acts on', () => {
    renderMenu();
    expect(screen.getByRole('menu', { name: 'Actions for commit a1b2c3d' })).toBeTruthy();
  });

  it('draws every item, in order, including the ones that cannot run', () => {
    renderMenu();
    expect(items().map((item) => item.textContent)).toEqual([
      'Checkout this commit',
      'Copy commit sha',
      'Rebase main onto this commit',
      'Reset main to this commit›',
    ]);
  });

  it('focuses the first item so the keyboard works without a click', () => {
    renderMenu();
    expect(document.activeElement).toBe(items()[0]);
  });

  it('runs an item and closes', () => {
    const onCheckout = vi.fn();
    const { onClose } = renderMenu({ onCheckout });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Checkout this commit' }));
    expect(onCheckout).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('items that cannot run', () => {
  it('says why, next to the item rather than in a tooltip', () => {
    renderMenu();
    expect(screen.getByText('HEAD is detached.')).toBeTruthy();
  });

  it('marks them disabled in role but keeps them reachable', () => {
    renderMenu();
    const blocked = screen.getByRole('menuitem', {
      name: /Rebase main/,
    });
    expect(blocked.getAttribute('aria-disabled')).toBe('true');
    expect(blocked.hasAttribute('disabled')).toBe(false);
  });

  it('points the item at its own explanation', () => {
    renderMenu();
    const blocked = screen.getByRole('menuitem', {
      name: /Rebase main/,
    });
    const described = blocked.getAttribute('aria-describedby');
    expect(described).not.toBeNull();
    expect(document.getElementById(described ?? '')?.textContent).toBe(
      'HEAD is detached.',
    );
  });

  it('does nothing when clicked, and leaves the menu open', () => {
    const { onClose } = renderMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Rebase main/ }));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('keyboard navigation', () => {
  it('walks down and up the list', () => {
    renderMenu();
    const menu = screen.getByRole('menu', { name: /Actions for commit/ });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items()[1]);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items()[0]);
  });

  it('wraps from the last item back to the first', () => {
    renderMenu();
    const menu = screen.getByRole('menu', { name: /Actions for commit/ });
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(items()[items().length - 1]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items()[0]);
  });

  it('closes on Escape', () => {
    const { onClose } = renderMenu();
    fireEvent.keyDown(screen.getByRole('menu', { name: /Actions for commit/ }), {
      key: 'Escape',
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes when something outside is clicked', () => {
    const { onClose } = renderMenu();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('stays open when the click is inside it', () => {
    const { onClose } = renderMenu();
    fireEvent.mouseDown(screen.getByRole('menu', { name: /Actions for commit/ }));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('submenus', () => {
  it('does not draw the children until the parent is opened', () => {
    renderMenu();
    expect(screen.queryByRole('menuitem', { name: 'Soft' })).toBeNull();
  });

  it('opens on click and moves the cursor into it', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Reset main/ }));
    const submenu = screen.getByRole('menu', { name: /Reset main/ });
    expect(document.activeElement).toBe(within(submenu).getAllByRole('menuitem')[0]);
  });

  it('opens on ArrowRight', () => {
    renderMenu();
    const parent = screen.getByRole('menuitem', { name: /Reset main/ });
    fireEvent.keyDown(parent, { key: 'ArrowRight' });
    expect(screen.getByRole('menuitem', { name: 'Soft' })).toBeTruthy();
  });

  it('reports its expanded state', () => {
    renderMenu();
    const parent = screen.getByRole('menuitem', { name: /Reset main/ });
    expect(parent.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(parent);
    expect(
      screen.getByRole('menuitem', { name: /Reset main/ }).getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('opening the parent does not choose anything', () => {
    const onSoft = vi.fn();
    const { onClose } = renderMenu({ onSoft });
    fireEvent.click(screen.getByRole('menuitem', { name: /Reset main/ }));
    expect(onSoft).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('runs a child and closes the whole menu', () => {
    const onSoft = vi.fn();
    const { onClose } = renderMenu({ onSoft });
    fireEvent.click(screen.getByRole('menuitem', { name: /Reset main/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Soft' }));
    expect(onSoft).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('arrow keys walk the submenu, not the list behind it', () => {
    renderMenu();
    const menu = screen.getByRole('menu', { name: /Actions for commit/ });
    fireEvent.click(screen.getByRole('menuitem', { name: /Reset main/ }));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Hard' }));
  });

  it('Escape closes the submenu first, not the whole menu', () => {
    const { onClose } = renderMenu();
    const menu = screen.getByRole('menu', { name: /Actions for commit/ });
    fireEvent.click(screen.getByRole('menuitem', { name: /Reset main/ }));
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menuitem', { name: 'Soft' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ArrowLeft returns to the item that opened it', () => {
    renderMenu();
    const menu = screen.getByRole('menu', { name: /Actions for commit/ });
    fireEvent.click(screen.getByRole('menuitem', { name: /Reset main/ }));
    fireEvent.keyDown(menu, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(
      screen.getByRole('menuitem', { name: /Reset main/ }),
    );
  });
});

describe('placement', () => {
  it('gives focus back to whatever had it when it closes', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();

    const { unmount } = render(
      <ContextMenu
        sections={sections()}
        x={10}
        y={10}
        label="Actions for commit a1b2c3d"
        onClose={() => {}}
      />,
    );
    expect(document.activeElement).not.toBe(opener);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('is pulled back inside the window when it would overflow the bottom', () => {
    render(
      <ContextMenu
        sections={sections()}
        x={10}
        y={window.innerHeight + 500}
        label="Actions for commit a1b2c3d"
        onClose={() => {}}
      />,
    );
    const menu = screen.getByRole('menu', { name: /Actions for commit/ });
    expect(Number.parseFloat(menu.style.top)).toBeLessThan(window.innerHeight);
  });

  it('never places itself off the top or left edge', () => {
    render(
      <ContextMenu
        sections={sections()}
        x={-200}
        y={-200}
        label="Actions for commit a1b2c3d"
        onClose={() => {}}
      />,
    );
    const menu = screen.getByRole('menu', { name: /Actions for commit/ });
    expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(0);
    expect(Number.parseFloat(menu.style.top)).toBeGreaterThanOrEqual(0);
  });
});
