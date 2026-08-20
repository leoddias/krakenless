import { type ReactNode } from 'react';
import { useAppState, useStore } from '../../state/hooks';
import styles from './NoticeBar.module.css';

/**
 * The one place a completed operation gets to say what it did.
 *
 * It stays on screen until dismissed. A discard's recovery command is the only
 * route back to the discarded work, and a notification that fades after three
 * seconds would take that route with it — so nothing here is on a timer.
 */
export function NoticeBar(): ReactNode {
  const store = useStore();
  const notice = useAppState((state) => state.notice);

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
