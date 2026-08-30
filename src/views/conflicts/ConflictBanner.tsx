import { type ReactNode } from 'react';
import { openInEditor, openMergetool, refreshStatus } from '../../state/actions';
import { useAppState, useStore } from '../../state/hooks';
import { isBusy } from '../../state/store';
import { conflictDescription, offersMergetool } from './conflicts';
import styles from './ConflictBanner.module.css';

/**
 * What is conflicted, and how to get at each file.
 *
 * The *ways out* — continue, skip, abort — deliberately do not live here. They
 * belong to the operation, not to the conflicts: a rebase can stop with nothing
 * conflicted at all, and this banner would be absent exactly when the user most
 * needs a way forward. They live next to the commit box instead, in
 * `OperationPanel`, which knows which operation is actually running.
 *
 * This banner used to own an "Abort merge" button that ran `git merge --abort`
 * whatever was in progress. During a rebase that fails with "MERGE_HEAD
 * missing" and strands the user. It is gone for good.
 */
export function ConflictBanner(): ReactNode {
  const store = useStore();
  const status = useAppState((state) => state.status);
  const busy = useAppState(isBusy);
  const operation = useAppState((state) => state.operation);

  if (status.state !== 'ready' || !status.value.hasConflicts) return null;

  const conflicted = status.value.entries.filter((entry) => entry.conflicted);
  // Named, not assumed. "Stopped during a rebase" and "stopped during a merge"
  // are different situations with different ways out, and the user has to be
  // told which one they are in before they can act on it.
  const during =
    operation.kind === null ? 'an operation' : `a ${operation.kind.replace('-', ' ')}`;

  return (
    <section className={styles.banner} aria-label="Conflicts" role="alert">
      <header className={styles.header}>
        <strong className={styles.title}>
          {conflicted.length === 1
            ? '1 file is conflicted'
            : `${conflicted.length} files are conflicted`}
        </strong>
        <p className={styles.text}>
          Stopped during {during}. Resolve each file below — in Krakenless, in your
          editor, or with your merge tool — then stage it. The way to carry on, or to give
          up, is under the commit box.
        </p>
      </header>

      <ul className={styles.list}>
        {conflicted.map((entry) => (
          <li key={entry.path} className={styles.item}>
            <div className={styles.itemText}>
              {/*
                The path is the way in. Clicking a conflicted file is what a
                user tries first, and until now it did nothing at all.
              */}
              <button
                type="button"
                className={styles.pathButton}
                disabled={busy}
                title={`Resolve ${entry.path} here`}
                onClick={() => store.dispatch({ type: 'resolve/open', path: entry.path })}
              >
                <code className={styles.path}>{entry.path}</code>
              </button>
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
      </div>
    </section>
  );
}
