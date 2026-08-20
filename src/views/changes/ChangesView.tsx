/**
 * Working-tree panel: staged and unstaged files, staging actions, and the
 * commit box.
 *
 * Three rules shape this file. First, discard never runs straight from a click:
 * it goes through an explicit confirmation that names the paths, and the stash
 * label that comes back is shown as a notice that survives whatever the status
 * panel does next, because "you can get it back" is the only reason a
 * destructive button is allowed here at all. Second, the confirmed path set is
 * re-checked against the current status before anything runs — the working tree
 * can move while the dialog is open, and discarding paths the dialog never
 * showed is exactly the mis-click this confirmation exists to prevent. Third,
 * conflicted paths get their own list with no stage or discard button: staging
 * a file full of conflict markers records a wrong resolution without saying so.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { RepoStatus, StatusEntry } from '../../git/types';
import { commitStaged, discard, stage, unstage } from '../../state/actions';
import { useAppState, useStore } from '../../state/hooks';
import type { Loadable } from '../../state/store';
import styles from './ChangesView.module.css';
import {
  conflictDescription,
  discardQuestion,
  displayPath,
  groupEntries,
  pathsOf,
  pathsOfAll,
  recoveryMessage,
  STATE_LABELS,
  STATE_LETTERS,
} from './labels';

interface Recovery {
  stashLabel: string;
  paths: string[];
}

/** The working-tree panel. Reads the store, acts only through the action layer. */
export function ChangesView(): ReactNode {
  const status = useAppState((state) => state.status);
  const busy = useAppState((state) => state.busy);
  const store = useStore();

  const [pendingDiscard, setPendingDiscard] = useState<string[] | null>(null);
  const [pendingChanged, setPendingChanged] = useState(false);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const askDiscard = (paths: string[]): void => {
    setRecovery(null);
    setFailure(null);
    setPendingChanged(false);
    setPendingDiscard(paths);
  };

  const cancelDiscard = (): void => {
    setPendingDiscard(null);
    setPendingChanged(false);
  };

  const runDiscard = async (paths: string[]): Promise<void> => {
    // Read the status as it is *now*, not as it was when the dialog opened.
    const available = discardablePaths(store.getState().status);
    const stillThere = paths.filter((path) => available.has(path));

    if (stillThere.length !== paths.length) {
      setPendingChanged(true);
      if (stillThere.length === 0) {
        setPendingDiscard(null);
        setFailure(
          'Those paths no longer have unstaged changes, so nothing was discarded.',
        );
      } else {
        setPendingDiscard(stillThere);
      }
      return;
    }

    setPendingDiscard(null);
    setPendingChanged(false);
    setFailure(null);
    try {
      const result = await discard(store, paths);
      if (result === null) {
        // No repository, or nothing to discard: say so rather than imply a
        // stash exists that the user could pop.
        setFailure('Nothing was discarded, so there is nothing to recover.');
        return;
      }
      setRecovery({ stashLabel: result.stashLabel, paths });
    } catch (error) {
      setFailure(
        `Discard failed, so your changes are still in the working tree. ${messageOf(error)}`,
      );
    }
  };

  const groups = status.state === 'ready' ? groupEntries(status.value.entries) : null;
  const stagedPaths = new Set(groups === null ? [] : pathsOfAll(groups.staged));

  return (
    <section className={styles.panel} aria-label="Changes">
      {/*
        The recovery and failure notices live above the status switch on
        purpose: a status read that fails right after a discard must not take
        the only instructions for getting the work back off the screen.
      */}
      {recovery !== null && (
        <RecoveryNotice recovery={recovery} onDismiss={() => setRecovery(null)} />
      )}

      {failure !== null && (
        <div className={styles.failure} role="alert">
          <p className={styles.noticeText}>{failure}</p>
          <button
            type="button"
            className={styles.button}
            onClick={() => setFailure(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {pendingDiscard !== null && (
        <DiscardConfirmation
          paths={pendingDiscard}
          stagedToo={pendingDiscard.filter((path) => stagedPaths.has(path))}
          listChanged={pendingChanged}
          busy={busy}
          onCancel={cancelDiscard}
          onConfirm={() => void runDiscard(pendingDiscard)}
        />
      )}

      {status.state === 'idle' && (
        <Notice title="No repository open">
          Open a repository to see its working-tree changes.
        </Notice>
      )}

      {status.state === 'loading' && (
        <Notice title="Loading changes…" live>
          Reading the working tree from git.
        </Notice>
      )}

      {status.state === 'error' && (
        <Notice title="Could not read the working tree" tone="error">
          {status.message}
          {status.kind !== undefined ? ` (${status.kind})` : ''}
        </Notice>
      )}

      {status.state === 'ready' && groups !== null && (
        <ChangeLists
          groups={groups}
          repoStatus={status.value}
          busy={busy}
          onStage={(paths) => void stage(store, paths)}
          onUnstage={(paths) => void unstage(store, paths)}
          onAskDiscard={askDiscard}
        />
      )}
    </section>
  );
}

/** Paths the panel is currently willing to discard: unstaged, not conflicted. */
function discardablePaths(status: Loadable<RepoStatus>): Set<string> {
  if (status.state !== 'ready') return new Set();
  return new Set(pathsOfAll(groupEntries(status.value.entries).unstaged));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ChangeLists({
  groups,
  repoStatus,
  busy,
  onStage,
  onUnstage,
  onAskDiscard,
}: {
  groups: ReturnType<typeof groupEntries>;
  repoStatus: RepoStatus;
  busy: boolean;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onAskDiscard: (paths: string[]) => void;
}): ReactNode {
  const { staged, unstaged, conflicted } = groups;
  const nothingToShow =
    staged.length === 0 && unstaged.length === 0 && conflicted.length === 0;

  return (
    <div className={styles.body}>
      {nothingToShow && (
        <Notice title="Working tree clean">
          Nothing is staged and nothing has changed since the last commit.
        </Notice>
      )}

      {conflicted.length > 0 && <ConflictList entries={conflicted} />}

      <FileSection
        title="Staged"
        entries={staged}
        side="index"
        emptyText="Nothing staged yet."
        bulkLabel="Unstage all"
        busy={busy}
        onBulk={onUnstage}
        rowActions={(entry) => [
          { label: 'Unstage', run: () => onUnstage(pathsOf(entry)) },
        ]}
      />

      <FileSection
        title="Unstaged"
        entries={unstaged}
        side="worktree"
        emptyText="No unstaged changes."
        bulkLabel="Stage all"
        busy={busy}
        onBulk={onStage}
        secondaryBulk={{
          label: 'Discard all',
          danger: true,
          run: (paths) => onAskDiscard(paths),
        }}
        rowActions={(entry) => [
          { label: 'Stage', run: () => onStage(pathsOf(entry)) },
          { label: 'Discard', danger: true, run: () => onAskDiscard(pathsOf(entry)) },
        ]}
      />

      <CommitBox
        stagedCount={staged.length}
        hasConflicts={repoStatus.hasConflicts || conflicted.length > 0}
        head={repoStatus.head}
        busy={busy}
      />
    </div>
  );
}

function RecoveryNotice({
  recovery,
  onDismiss,
}: {
  recovery: Recovery;
  onDismiss: () => void;
}): ReactNode {
  return (
    <div className={styles.recovery} role="status">
      <strong className={styles.noticeTitle}>Changes discarded — recoverable</strong>
      <p className={styles.noticeText}>{recoveryMessage(recovery.stashLabel)}</p>
      <ul className={styles.pathList}>
        {recovery.paths.map((path) => (
          <li key={path} className={styles.path}>
            {path}
          </li>
        ))}
      </ul>
      <button type="button" className={styles.button} onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

function DiscardConfirmation({
  paths,
  stagedToo,
  listChanged,
  busy,
  onCancel,
  onConfirm,
}: {
  paths: string[];
  stagedToo: string[];
  listChanged: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactNode {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // The safe choice takes focus, so a stray Enter cancels instead of discards.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <div
      className={styles.confirm}
      role="alertdialog"
      aria-label="Confirm discard"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <strong className={styles.noticeTitle}>{discardQuestion(paths)}</strong>
      {listChanged && (
        <p className={styles.warning}>
          The working tree changed while this was open, so the list below is not what you
          first confirmed. Nothing has been discarded — review it and confirm again.
        </p>
      )}
      <p className={styles.noticeText}>
        These working-tree changes will be removed from the files below. Krakenless
        stashes them first, so you will be able to bring them back with{' '}
        <code>git stash pop --index</code>.
      </p>
      {stagedToo.length > 0 && (
        <p className={styles.warning}>
          {stagedToo.length === 1
            ? 'One of these paths also has staged changes; git stashes the staged side with it.'
            : `${stagedToo.length} of these paths also have staged changes; git stashes the staged side with them.`}{' '}
          Recover with <code>git stash pop --index</code> to get the staged version back
          as well.
        </p>
      )}
      <ul className={styles.pathList}>
        {paths.map((path) => (
          <li key={path} className={styles.path}>
            {path}
          </li>
        ))}
      </ul>
      <div className={styles.confirmActions}>
        <button
          type="button"
          className={styles.button}
          ref={cancelRef}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.danger}`}
          disabled={busy}
          onClick={onConfirm}
        >
          {paths.length === 1 ? 'Discard 1 file' : `Discard ${paths.length} files`}
        </button>
      </div>
    </div>
  );
}

interface RowAction {
  label: string;
  danger?: boolean;
  run: () => void;
}

function FileSection({
  title,
  entries,
  side,
  emptyText,
  bulkLabel,
  secondaryBulk,
  busy,
  onBulk,
  rowActions,
}: {
  title: string;
  entries: StatusEntry[];
  side: 'index' | 'worktree';
  emptyText: string;
  bulkLabel: string;
  secondaryBulk?: { label: string; danger?: boolean; run: (paths: string[]) => void };
  busy: boolean;
  onBulk: (paths: string[]) => void;
  rowActions: (entry: StatusEntry) => RowAction[];
}): ReactNode {
  const paths = pathsOfAll(entries);
  const label = `${title} (${entries.length})`;

  return (
    <section className={styles.section} aria-label={title}>
      <header className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>{label}</h2>
        <div className={styles.sectionActions}>
          <button
            type="button"
            className={styles.button}
            disabled={busy || entries.length === 0}
            onClick={() => onBulk(paths)}
          >
            {bulkLabel}
          </button>
          {secondaryBulk !== undefined && (
            <button
              type="button"
              className={`${styles.button} ${secondaryBulk.danger === true ? styles.danger : ''}`}
              disabled={busy || entries.length === 0}
              onClick={() => secondaryBulk.run(paths)}
            >
              {secondaryBulk.label}
            </button>
          )}
        </div>
      </header>

      {entries.length === 0 ? (
        <p className={styles.empty}>{emptyText}</p>
      ) : (
        <ul className={styles.list}>
          {entries.map((entry) => (
            <li key={entry.path} className={styles.row}>
              <span className={styles.state} title={STATE_LABELS[entry[side]]}>
                {STATE_LETTERS[entry[side]]}
              </span>
              <span className={styles.path}>{displayPath(entry)}</span>
              <span className={styles.stateLabel}>{STATE_LABELS[entry[side]]}</span>
              <span className={styles.rowActions}>
                {rowActions(entry).map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    className={`${styles.button} ${action.danger === true ? styles.danger : ''}`}
                    disabled={busy}
                    onClick={action.run}
                  >
                    <span aria-hidden="true">{action.label}</span>
                    <span className={styles.srOnly}>
                      {`${action.label} ${displayPath(entry)}`}
                    </span>
                  </button>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ConflictList({ entries }: { entries: StatusEntry[] }): ReactNode {
  return (
    <section className={styles.section} aria-label="Conflicted">
      <header className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>{`Conflicted (${entries.length})`}</h2>
      </header>
      <p className={styles.conflictNote}>
        Resolve these files in your editor first. Krakenless will not stage or discard an
        unmerged path: staging it as-is would record the conflict markers as the
        resolution.
      </p>
      <ul className={styles.list}>
        {entries.map((entry) => (
          <li key={entry.path} className={`${styles.row} ${styles.conflictRow}`}>
            <span className={styles.state} title={STATE_LABELS.unmerged}>
              {STATE_LETTERS.unmerged}
            </span>
            <span className={styles.path}>{displayPath(entry)}</span>
            <span className={styles.stateLabel}>
              {conflictDescription(entry.conflictKind)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CommitBox({
  stagedCount,
  hasConflicts,
  head,
  busy,
}: {
  stagedCount: number;
  hasConflicts: boolean;
  head: string | null;
  busy: boolean;
}): ReactNode {
  const store = useStore();
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const empty = message.trim().length === 0;
  const disabled = busy || empty || stagedCount === 0;
  // Amending mid-merge would rewrite a commit while the operation is still
  // running, and unlike a plain commit git would not stop it.
  const canAmend = !hasConflicts && head !== null;

  const submit = async (): Promise<void> => {
    setError(null);
    if (store.getState().repo.state !== 'ready') {
      setError('No repository is open.');
      return;
    }
    try {
      await commitStaged(store, { message, amend });
      setMessage('');
      setAmend(false);
    } catch (failure) {
      setError(messageOf(failure));
    }
  };

  return (
    <section className={styles.commit} aria-label="Commit">
      <label className={styles.commitLabel} htmlFor="commit-message">
        Commit message
      </label>
      <textarea
        id="commit-message"
        className={styles.textarea}
        rows={3}
        value={message}
        disabled={busy}
        onChange={(event) => setMessage(event.target.value)}
      />

      <label className={styles.amend}>
        <input
          type="checkbox"
          checked={amend && canAmend}
          disabled={busy || !canAmend}
          onChange={(event) => setAmend(event.target.checked)}
        />
        Amend the last commit
      </label>
      {!canAmend && (
        <p className={styles.commitHint}>
          {hasConflicts
            ? 'Amending is unavailable while the repository has conflicts.'
            : 'Amending is unavailable: there is no commit yet.'}
        </p>
      )}
      {amend && canAmend && (
        <p className={styles.amendWarning} role="status">
          {`Amending rewrites the last commit${head === null ? '' : ` (${head.slice(0, 7)})`}: it gets a new hash, and anyone who already fetched it will need to reconcile. The old commit stays in the reflog. Do not amend a commit you have pushed.`}
        </p>
      )}

      {error !== null && (
        <p className={styles.commitError} role="alert">
          {`Commit failed: ${error}`}
        </p>
      )}

      <div className={styles.commitActions}>
        <span className={styles.commitHint}>{commitHint(stagedCount, empty)}</span>
        <button
          type="button"
          className={`${styles.button} ${styles.primary}`}
          disabled={disabled}
          onClick={() => void submit()}
        >
          {amend && canAmend ? 'Amend commit' : 'Commit'}
        </button>
      </div>
    </section>
  );
}

/** Says why the button is off, instead of leaving a dead control on screen. */
function commitHint(stagedCount: number, emptyMessage: boolean): string {
  if (stagedCount === 0) return 'Stage at least one file to commit.';
  if (emptyMessage) return 'Write a commit message to commit.';
  return stagedCount === 1 ? '1 file staged.' : `${stagedCount} files staged.`;
}

function Notice({
  title,
  tone = 'neutral',
  live = false,
  children,
}: {
  title: string;
  tone?: 'neutral' | 'error';
  live?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <div
      className={
        tone === 'error' ? `${styles.notice} ${styles.noticeError}` : styles.notice
      }
      role={tone === 'error' ? 'alert' : live ? 'status' : undefined}
    >
      <strong className={styles.noticeTitle}>{title}</strong>
      <p className={styles.noticeText}>{children}</p>
    </div>
  );
}
