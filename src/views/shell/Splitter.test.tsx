import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Splitter, type SplitterProps } from './Splitter';

function renderSplitter(overrides: Partial<SplitterProps> = {}) {
  const props: SplitterProps = {
    orientation: 'vertical',
    label: 'Resize the branches panel',
    value: 264,
    min: 180,
    max: 560,
    onDragStart: vi.fn(),
    onDrag: vi.fn(),
    onDragEnd: vi.fn(),
    onNudge: vi.fn(),
    ...overrides,
  };
  const { unmount } = render(<Splitter {...props} />);
  return {
    props,
    unmount,
    handle: screen.getByRole('separator', { name: props.label }),
  };
}

describe('Splitter', () => {
  it('describes itself as a separator with its current size', () => {
    const { handle } = renderSplitter();
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle).toHaveAttribute('aria-valuenow', '264');
    expect(handle).toHaveAttribute('aria-valuemin', '180');
    expect(handle).toHaveAttribute('aria-valuemax', '560');
  });

  it('is reachable by keyboard, so resizing is not a mouse-only feature', () => {
    const { handle } = renderSplitter();
    expect(handle).toHaveAttribute('tabindex', '0');
  });

  it('reports the travel since the drag began, not since the last move', () => {
    const { props, handle } = renderSplitter();
    fireEvent.mouseDown(handle, { clientX: 100, button: 0 });
    expect(props.onDragStart).toHaveBeenCalledTimes(1);

    fireEvent.mouseMove(window, { clientX: 130 });
    fireEvent.mouseMove(window, { clientX: 160 });

    expect(props.onDrag).toHaveBeenNthCalledWith(1, 30);
    expect(props.onDrag).toHaveBeenNthCalledWith(2, 60);
  });

  it('measures a horizontal edge along the other axis', () => {
    const { props, handle } = renderSplitter({ orientation: 'horizontal' });
    fireEvent.mouseDown(handle, { clientY: 50, button: 0 });
    fireEvent.mouseMove(window, { clientY: 90, clientX: 400 });
    expect(props.onDrag).toHaveBeenCalledWith(40);
  });

  it('stops tracking once the button is released', () => {
    const { props, handle } = renderSplitter();
    fireEvent.mouseDown(handle, { clientX: 100, button: 0 });
    fireEvent.mouseUp(window);
    expect(props.onDragEnd).toHaveBeenCalledTimes(1);

    fireEvent.mouseMove(window, { clientX: 400 });
    expect(props.onDrag).not.toHaveBeenCalled();
  });

  it('restores the page after a drag, rather than leaving it unselectable', () => {
    const { handle } = renderSplitter();
    fireEvent.mouseDown(handle, { clientX: 100, button: 0 });
    expect(document.body.style.userSelect).toBe('none');
    fireEvent.mouseUp(window);
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('ignores a non-primary button, which belongs to the context menu', () => {
    const { props, handle } = renderSplitter();
    fireEvent.mouseDown(handle, { clientX: 100, button: 2 });
    fireEvent.mouseMove(window, { clientX: 200 });
    expect(props.onDragStart).not.toHaveBeenCalled();
    expect(props.onDrag).not.toHaveBeenCalled();
  });

  it('leaves nothing listening when it unmounts mid-drag', () => {
    // A repository closed while an edge is being dragged must not leave a
    // window listener holding the unmounted component's callbacks, nor a page
    // the user can no longer select text on.
    const { props, handle, unmount } = renderSplitter();
    fireEvent.mouseDown(handle, { clientX: 100, button: 0 });
    unmount();

    fireEvent.mouseMove(window, { clientX: 400 });
    expect(props.onDrag).not.toHaveBeenCalled();
    expect(document.body.style.userSelect).toBe('');
  });

  it('moves with the arrow keys, and further with shift held', () => {
    const { props, handle } = renderSplitter();
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    expect(props.onNudge).toHaveBeenNthCalledWith(1, 16);
    expect(props.onNudge).toHaveBeenNthCalledWith(2, -16);
    expect(props.onNudge).toHaveBeenNthCalledWith(3, 64);
  });

  it('uses the up and down keys for a horizontal edge', () => {
    const { props, handle } = renderSplitter({ orientation: 'horizontal' });
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(props.onNudge).toHaveBeenNthCalledWith(1, 16);
    expect(props.onNudge).toHaveBeenNthCalledWith(2, -16);
    expect(props.onNudge).toHaveBeenCalledTimes(2);
  });
});
