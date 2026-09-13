import { type ReactNode } from 'react';
import { useAppState, useStore } from '../../state/hooks';
import { useAutoDismiss } from './autoDismiss';
import styles from './NoticeBar.module.css';

/**
 * The one place a completed operation gets to say what it did.
 *
 * It goes away on its own after ten seconds, like every other dismissible
 * notice in the app (`useAutoDismiss`). It did not always: a discard's recovery
 * command used to live here and was the only route back to the discarded work,
 * so nothing was allowed to fade. ADR-0045 moved that route to the "Recent
 * discards" panel and its Undo button, and ADR-0051 put the rest on a timer.
 */
export function NoticeBar(): ReactNode {
  const store = useStore();
  const notice = useAppState((state) => state.notice);
  // Before the early return: a hook cannot be called conditionally, and a null
  // key is how this one says "nothing is showing".
  useAutoDismiss(notice?.id ?? null, () => {
    store.dispatch({ type: 'notice', notice: null });
  });

  if (notice === null) return null;

  return (
    <div
      className={`${styles.bar} ${styles[notice.tone]}`}
      role={notice.tone === 'error' ? 'alert' : 'status'}
    >
      <div className={styles.body}>
        <p className={styles.message}>{notice.message}</p>
        {notice.undoHint !== undefined && (
          <>
            <p className={styles.hintLabel}>Run this to undo:</p>
            {notice.undoHint.split('\n').map((command) => (
              <pre key={command} className={styles.command}>
                <code>{command}</code>
              </pre>
            ))}
          </>
        )}
      </div>
      <button
        type="button"
        className={styles.dismiss}
        onClick={() => store.dispatch({ type: 'notice', notice: null })}
      >
        Dismiss
      </button>
    </div>
  );
}
