/**
 * The way back from a discard.
 *
 * This exists because a notice is the wrong home for it. A notice is replaced
 * by the very next operation, and a discarded file has no stash entry, no
 * reflog and no commit behind it — the backup blob's oid is the only handle on
 * that work. Announcing it once and letting the next click overwrite the
 * announcement would be a recovery route in name only.
 *
 * Undo is a button rather than a printed command on purpose. `git cat-file -p
 * <oid> > path` restores byte-for-byte in `cmd.exe` and `pwsh`, but in Windows
 * PowerShell 5.1 — the default shell on Windows 11 — `>` is `Out-File`, which
 * re-encodes the stream to UTF-16LE with a byte-order mark and appends a
 * newline. Handing that to the user would corrupt the file it claims to save.
 *
 * One discard is one row. "Discard all" over a build directory records
 * thousands of files at once; a row per file would push the repository off
 * the screen, so files that share a discard fold into one row with one Undo,
 * and open on request for the file-by-file buttons.
 */

import { useState, type ReactNode } from 'react';
import { undoDiscard, undoDiscards } from '../../state/actions';
import { useAppState, useStore } from '../../state/hooks';
import { isBusy, type DiscardBackup } from '../../state/store';
import styles from './DiscardBackups.module.css';

/** The files of one discard, in the order they were recorded. */
interface DiscardGroup {
  at: string;
  backups: DiscardBackup[];
}

/**
 * Folds the flat, newest-first list into one group per discard.
 *
 * Pure and exported so the folding — the one rule that decides how many rows
 * a discard becomes — is asserted on its own.
 */
export function groupDiscards(discards: readonly DiscardBackup[]): DiscardGroup[] {
  const groups: DiscardGroup[] = [];
  for (const backup of discards) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.at === backup.at) last.backups.push(backup);
    else groups.push({ at: backup.at, backups: [backup] });
  }
  return groups;
}

export function DiscardBackups(): ReactNode {
  const discards = useAppState((state) => state.discards);

  if (discards.length === 0) return null;

  return (
    <section className={styles.bar} aria-label="Recent discards">
      <h2 className={styles.title}>Recent discards</h2>
      <ul className={styles.list}>
        {groupDiscards(discards).map((group) =>
          group.backups.length === 1 && group.backups[0] !== undefined ? (
            <FileRow key={group.backups[0].blobOid} backup={group.backups[0]} />
          ) : (
            <GroupRow key={group.at} group={group} />
          ),
        )}
      </ul>
    </section>
  );
}

function FileRow({ backup }: { backup: DiscardBackup }): ReactNode {
  const store = useStore();
  const busy = useAppState(isBusy);
  return (
    <li className={styles.row}>
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
  );
}

function GroupRow({ group }: { group: DiscardGroup }): ReactNode {
  const store = useStore();
  const busy = useAppState(isBusy);
  const [open, setOpen] = useState(false);
  const count = group.backups.length;
  const label = `${String(count)} files discarded together`;

  return (
    <li className={styles.row}>
      <button
        type="button"
        className={styles.groupToggle}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={styles.chevron} aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <code className={styles.path}>{label}</code>
      </button>
      <button
        type="button"
        className={styles.undo}
        disabled={busy}
        title={`Restore all ${String(count)} files from the backups taken before the discard`}
        onClick={() => {
          void undoDiscards(store, group.backups);
        }}
      >
        Undo all
      </button>
      <button
        type="button"
        className={styles.dismiss}
        disabled={busy}
        title="Hide these entries; the backups stay in the object store"
        onClick={() => {
          for (const backup of group.backups) {
            store.dispatch({ type: 'discard/forgotten', blobOid: backup.blobOid });
          }
        }}
      >
        Dismiss all
      </button>
      {open && (
        <ul className={styles.groupList} aria-label={label}>
          {group.backups.map((backup) => (
            <FileRow key={backup.blobOid} backup={backup} />
          ))}
        </ul>
      )}
    </li>
  );
}
