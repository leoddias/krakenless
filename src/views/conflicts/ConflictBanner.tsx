import { useState, type ReactNode } from 'react';
import {
  abortMergeInProgress,
  openInEditor,
  openMergetool,
  refreshStatus,
} from '../../state/actions';
import { useAppState, useStore } from '../../state/hooks';
import { conflictDescription, offersMergetool } from './conflicts';
import styles from './ConflictBanner.module.css';

/**
 * The honest conflict banner: what is conflicted, and the ways out.
 *
 * It offers no "resolve for me" button. Krakenless has no conflict-resolution
 * UI yet, and pretending otherwise — by staging a file full of markers, say —
 * is exactly the failure this banner exists to prevent.
 */
export function ConflictBanner(): ReactNode {
  const store = useStore();
  const status = useAppState((state) => state.status);
  const busy = useAppState((state) => state.busy);
  const [confirmingAbort, setConfirmingAbort] = useState(false);

  if (status.state !== 'ready' || !status.value.hasConflicts) return null;

  const conflicted = status.value.entries.filter((entry) => entry.conflicted);
  const abortQuestion = `Abort the merge and return to the state before it started? Any conflict resolutions you have made will be lost.`;

  return (
    <section className={styles.banner} aria-label="Conflicts" role="alert">
      <header className={styles.header}>
        <strong className={styles.title}>
          {conflicted.length === 1
            ? '1 file is conflicted'
            : `${conflicted.length} files are conflicted`}
        </strong>
        <p className={styles.text}>
          Krakenless does not resolve conflicts itself. Edit the files or use your merge
          tool, then stage them here.
        </p>
      </header>

      <ul className={styles.list}>
        {conflicted.map((entry) => (
          <li key={entry.path} className={styles.item}>
            <div className={styles.itemText}>
              <code className={styles.path}>{entry.path}</code>
              <span className={styles.kind}>
                {conflictDescription(entry.conflictKind)}
              </span>
            </div>
            <button
              type="button"
              className={styles.action}
              disabled={busy}
              onClick={() => void openInEditor(store, entry.path)}
            >
              Open in editor
            </button>
            {offersMergetool(entry.conflictKind) && (
              <button
                type="button"
                className={styles.action}
                disabled={busy}
                onClick={() => void openMergetool(store, entry.path)}
              >
                Merge tool
              </button>
            )}
          </li>
        ))}
      </ul>

      <div className={styles.footer}>
        <button
          type="button"
          className={styles.action}
          disabled={busy}
          onClick={() => void refreshStatus(store)}
        >
          Re-check
        </button>
        {confirmingAbort ? (
          <span className={styles.confirm}>
            <span className={styles.text}>{abortQuestion}</span>
            <button
              type="button"
              className={styles.danger}
              disabled={busy}
              onClick={() => {
                setConfirmingAbort(false);
                void abortMergeInProgress(store, abortQuestion);
              }}
            >
              Abort merge
            </button>
            <button
              type="button"
              className={styles.action}
              onClick={() => setConfirmingAbort(false)}
            >
              Keep merging
            </button>
          </span>
        ) : (
          <button
            type="button"
            className={styles.danger}
            disabled={busy}
            onClick={() => setConfirmingAbort(true)}
          >
            Abort merge…
          </button>
        )}
      </div>
    </section>
  );
}
