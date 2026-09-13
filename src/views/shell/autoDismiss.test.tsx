import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState, type ReactNode } from 'react';
import { DISMISS_AFTER_MS, useAutoDismiss } from './autoDismiss';

afterEach(cleanup);

function Probe({
  noticeKey,
  onDismiss,
}: {
  noticeKey: string | number | null;
  onDismiss: () => void;
}): ReactNode {
  useAutoDismiss(noticeKey, onDismiss);
  return <p>{noticeKey === null ? 'nothing' : String(noticeKey)}</p>;
}

describe('useAutoDismiss', () => {
  it('dismisses once the delay has passed', () => {
    vi.useFakeTimers();
    const dismiss = vi.fn();
    render(<Probe noticeKey="a" onDismiss={dismiss} />);

    act(() => {
      vi.advanceTimersByTime(DISMISS_AFTER_MS - 1);
    });
    expect(dismiss).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(dismiss).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('runs no timer while nothing is showing', () => {
    vi.useFakeTimers();
    const dismiss = vi.fn();
    render(<Probe noticeKey={null} onDismiss={dismiss} />);

    act(() => {
      vi.advanceTimersByTime(DISMISS_AFTER_MS * 3);
    });

    expect(dismiss).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('restarts the clock when a different notice takes the place of the first', () => {
    // Otherwise the second notice inherits whatever was left of the first
    // one's ten seconds and can be gone almost as soon as it appears.
    vi.useFakeTimers();
    const dismiss = vi.fn();
    const { rerender } = render(<Probe noticeKey={1} onDismiss={dismiss} />);

    act(() => {
      vi.advanceTimersByTime(DISMISS_AFTER_MS - 100);
    });
    rerender(<Probe noticeKey={2} onDismiss={dismiss} />);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(dismiss).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(DISMISS_AFTER_MS);
    });
    expect(dismiss).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('does not reset the timer when the caller passes a fresh closure', () => {
    // Every render of a notice builds a new `() => setX(null)`. Reading the
    // callback through a ref is what stops a re-render from making a notice
    // immortal — a parent that re-renders every second would otherwise keep
    // restarting a ten-second clock that never reaches the end.
    vi.useFakeTimers();
    const dismiss = vi.fn();
    function Host(): ReactNode {
      const [tick, setTick] = useState(0);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setTick(tick + 1);
            }}
          >
            re-render
          </button>
          <Probe
            noticeKey="a"
            onDismiss={() => {
              dismiss(tick);
            }}
          />
        </>
      );
    }
    render(<Host />);

    for (let elapsed = 0; elapsed < DISMISS_AFTER_MS; elapsed += 1000) {
      act(() => {
        screen.getByRole('button', { name: 're-render' }).click();
        vi.advanceTimersByTime(1000);
      });
    }

    expect(dismiss).toHaveBeenCalledTimes(1);
    // And it is a re-rendered closure that ran, not the one captured on mount:
    // `tick` was 0 then and nine or ten re-renders have happened since.
    expect(dismiss.mock.calls[0]?.[0]).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it('dismisses only once, however long the notice is left alone', () => {
    vi.useFakeTimers();
    const dismiss = vi.fn();
    render(<Probe noticeKey="a" onDismiss={dismiss} />);

    act(() => {
      vi.advanceTimersByTime(DISMISS_AFTER_MS * 5);
    });

    expect(dismiss).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('cancels the timer when the notice unmounts first', () => {
    vi.useFakeTimers();
    const dismiss = vi.fn();
    const { unmount } = render(<Probe noticeKey="a" onDismiss={dismiss} />);

    unmount();
    act(() => {
      vi.advanceTimersByTime(DISMISS_AFTER_MS * 2);
    });

    expect(dismiss).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
