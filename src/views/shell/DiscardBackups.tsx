/**
 * The way back from a discarded hunk.
 *
 * This exists because a notice is the wrong home for it. A notice is replaced
 * by the very next operation, and a discarded hunk has no stash entry, no
 * reflog and no commit behind it — the backup blob's oid is the only handle on
 * that work. Announcing it once and letting the next click overwrite the
 * announcement would be a recovery route in name only.
 *
 * Undo is a button rather than a printed command on purpose. `git cat-file -p
 * <oid> > path` restores byte-for-byte in `cmd.exe` and `pwsh`, but in Windows
 * PowerShell 5.1 — the default shell on Windows 11 — `>` is `Out-File`, which
 * re-encodes the stream to UTF-16LE with a byte-order mark and appends a
 * newline. Handing that to the user would corrupt the file it claims to save.
 */

import { type ReactNode } from 'react';
import { undoDiscard } from '../../state/actions';
import { useAppState, useStore } from '../../state/hooks';
import { isBusy } from '../../state/store';
import styles from './DiscardBackups.module.css';

export function DiscardBackups(): ReactNode {
  const store = useStore();
  const discards = useAppState((state) => state.discards);
  const busy = useAppState(isBusy);

  if (discards.length === 0) return null;

  return (
    <section className={styles.bar} aria-label="Recent discards">
      <h2 className={styles.title}>Recent discards</h2>
      <ul className={styles.list}>
        {discards.map((backup) => (
          <li key={backup.blobOid} className={styles.row}>
            <code className={styles.path}>{backup.path}</code>
            {/*
              The oid is shown, not hidden behind the button: if the app closes
              with an entry still here, this string is what makes the blob
              findable again with `git cat-file`.
            */}
            <code className={styles.oid} title="Backup blob">
              {backup.blobOid.slice(0, 10)}
            </code>
            <button
              type="button"
              className={styles.undo}
              disabled={busy}
              title={`Restore ${backup.path} from the backup taken before the discard`}
              onClick={() => {
                void undoDiscard(store, backup);
              }}
            >
              Undo
            </button>
            <button
              type="button"
              className={styles.dismiss}
              disabled={busy}
              // Only removes the row. The blob stays in the object store, so a
              // dismissal is never the thing that loses the work.
              title="Hide this entry; the backup stays in the object store"
              onClick={() => {
                store.dispatch({ type: 'discard/forgotten', blobOid: backup.blobOid });
              }}
            >
              Dismiss
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
