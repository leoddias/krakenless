/**
 * Working-tree panel: staged and unstaged files, staging actions, and the
 * commit box.
 *
 * Two rules shape this file. First, discard never runs straight from a click:
 * it goes through an explicit confirmation that names the paths, and the stash
 * label that comes back is shown as a persistent notice, because "you can get
 * it back with `git stash pop`" is the only reason a destructive button is
 * allowed here at all. Second, conflicted paths get their own list with no
 * stage or discard button — staging a file full of conflict markers records a
 * wrong resolution without ever saying so.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { StatusEntry } from '../../git/types';
import { commitStaged, discard, stage, unstage } from '../../state/actions';
import { useAppState, useStore } from '../../state/hooks';
import styles from './ChangesView.module.css';
import {
  conflictDescription,
  discardQuestion,
  displayPath,
  groupEntries,
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
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const runDiscard = async (paths: string[]): Promise<void> => {
    setPendingDiscard(null);
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

  return (
    <section className={styles.panel} aria-label="Changes">
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

      {status.state === 'ready' && (
        <ChangeLists
          entries={status.value.entries}
          busy={busy}
          recovery={recovery}
          failure={failure}
          pendingDiscard={pendingDiscard}
          onStage={(paths) => void stage(store, paths)}
          onUnstage={(paths) => void unstage(store, paths)}
          onAskDiscard={(paths) => {
            setRecovery(null);
            setFailure(null);
            setPendingDiscard(paths);
          }}
          onCancelDiscard={() => setPendingDiscard(null)}
          onConfirmDiscard={(paths) => void runDiscard(paths)}
          onDismissRecovery={() => setRecovery(null)}
          onDismissFailure={() => setFailure(null)}
        />
      )}
    </section>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ListProps {
  entries: StatusEntry[];
  busy: boolean;
  recovery: Recovery | null;
  failure: string | null;
  pendingDiscard: string[] | null;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onAskDiscard: (paths: string[]) => void;
  onCancelDiscard: () => void;
  onConfirmDiscard: (paths: string[]) => void;
  onDismissRecovery: () => void;
  onDismissFailure: () => void;
}

function ChangeLists(props: ListProps): ReactNode {
  const { staged, unstaged, conflicted } = groupEntries(props.entries);
  const nothingToShow =
    staged.length === 0 && unstaged.length === 0 && conflicted.length === 0;

  return (
    <div className={styles.body}>
      {props.recovery !== null && (
        <RecoveryNotice recovery={props.recovery} onDismiss={props.onDismissRecovery} />
      )}

      {props.failure !== null && (
        <div className={styles.failure} role="alert">
          <p className={styles.noticeText}>{props.failure}</p>
          <button
            type="button"
            className={styles.button}
            onClick={props.onDismissFailure}
          >
            Dismiss
          </button>
        </div>
      )}

      {props.pendingDiscard !== null && (
        <DiscardConfirmation
          paths={props.pendingDiscard}
          busy={props.busy}
          onCancel={props.onCancelDiscard}
          onConfirm={() => props.onConfirmDiscard(props.pendingDiscard ?? [])}
        />
      )}

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
        busy={props.busy}
        onBulk={props.onUnstage}
        rowActions={(entry) => [
          { label: 'Unstage', run: () => props.onUnstage([entry.path]) },
        ]}
      />

      <FileSection
        title="Unstaged"
        entries={unstaged}
        side="worktree"
        emptyText="No unstaged changes."
        bulkLabel="Stage all"
        busy={props.busy}
        onBulk={props.onStage}
        secondaryBulk={{
          label: 'Discard all',
          danger: true,
          run: (paths) => props.onAskDiscard(paths),
        }}
        rowActions={(entry) => [
          { label: 'Stage', run: () => props.onStage([entry.path]) },
          {
            label: 'Discard',
            danger: true,
            run: () => props.onAskDiscard([entry.path]),
          },
        ]}
      />

      <CommitBox stagedCount={staged.length} busy={props.busy} />
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
  busy,
  onCancel,
  onConfirm,
}: {
  paths: string[];
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
      <p className={styles.noticeText}>
        These working-tree changes will be removed from the files below. Krakenless
        stashes them first, so you will be able to bring them back with{' '}
        <code>git stash pop</code>.
      </p>
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
  const paths = entries.map((entry) => entry.path);
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
              <span className={styles.state} aria-hidden="true">
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
            <span className={styles.state} aria-hidden="true">
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
  busy,
}: {
  stagedCount: number;
  busy: boolean;
}): ReactNode {
  const store = useStore();
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const empty = message.trim().length === 0;
  const disabled = busy || empty || stagedCount === 0;

  const submit = async (): Promise<void> => {
    setError(null);
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
          checked={amend}
          disabled={busy}
          onChange={(event) => setAmend(event.target.checked)}
        />
        Amend the last commit
      </label>
      {amend && (
        <p className={styles.amendWarning} role="status">
          Amending rewrites the last commit: it gets a new hash, and anyone who already
          fetched it will need to reconcile. Do not amend a commit you have pushed.
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
          {amend ? 'Amend commit' : 'Commit'}
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
