/**
 * Working-tree panel: staged and unstaged files, staging actions, and the
 * commit box.
 *
 * Four rules shape this file. Discard never runs straight from a click: it goes
 * through a confirmation that names the paths, and the stash label that comes
 * back is shown as a notice that outlives whatever the status panel does next,
 * because "you can get it back" is the only reason a destructive button is
 * allowed here at all. The confirmed path set is re-checked against the current
 * status before anything runs, and a status that cannot be read is treated as
 * "unknown", never as "clean". Conflicted paths get their own list with no
 * stage or discard button: staging a file full of conflict markers records a
 * wrong resolution without saying so. And the commit draft lives here rather
 * than in the commit box, because every refresh unmounts the lists and a user
 * mid-message must not lose it.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { RepoStatus, StatusEntry } from '../../git/types';
import {
  commitStaged,
  discard,
  refreshStatus,
  stage,
  unstage,
} from '../../state/actions';
import { useAppState, useStore } from '../../state/hooks';
import { isBusy } from '../../state/store';
import type { Loadable } from '../../state/store';
import styles from './ChangesView.module.css';
import {
  conflictDescription,
  discardQuestion,
  displayPath,
  groupEntries,
  pathsOf,
  pathsOfAll,
  partialRecoveryMessage,
  recoveryMessage,
  STATE_LABELS,
  STATE_LETTERS,
} from './labels';

interface Recovery {
  /** Local identity: two discards can share a label to the millisecond. */
  id: number;
  /** Commands the git layer produced; shown verbatim so they can be copied. */
  undoCommands: string[];
  /**
   * What those commands cannot bring back. Dropping these would show a command
   * above a path list it does not cover, which reads as "this restores them
   * all".
   */
  notes: string[];
  paths: string[];
}

/** Why the confirmation is being shown again instead of having run. */
type PendingNotice = 'none' | 'changed' | 'unchecked';

interface Pending {
  paths: string[];
  /** Confirmed paths that also carry staged changes; git stashes those too. */
  stagedToo: string[];
  notice: PendingNotice;
}

/** Draft of the commit the user is writing; kept above every refresh. */
interface CommitDraft {
  message: string;
  amend: boolean;
  error: string | null;
}

/** The working-tree panel. Reads the store, acts only through the action layer. */
export function ChangesView(): ReactNode {
  const status = useAppState((state) => state.status);
  const busy = useAppState(isBusy);
  const store = useStore();

  const [pending, setPending] = useState<Pending | null>(null);
  const [recoveries, setRecoveries] = useState<Recovery[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const nextRecoveryId = useRef(0);
  const [draft, setDraft] = useState<CommitDraft>({
    message: '',
    amend: false,
    error: null,
  });

  const groups = status.state === 'ready' ? groupEntries(status.value.entries) : null;
  const stagedPaths = new Set(groups === null ? [] : pathsOfAll(groups.staged));

  const askDiscard = (paths: string[]): void => {
    setFailure(null);
    setPending({
      paths,
      stagedToo: paths.filter((path) => stagedPaths.has(path)),
      notice: 'none',
    });
  };

  /**
   * Runs a staging write and, if it fails, says so and re-reads the status.
   *
   * A rejected `git add` can still have staged part of its pathspec, and the
   * action layer only refreshes on success — leaving the lists showing a world
   * that no longer matches the index is how a user commits what they believed
   * they had excluded.
   */
  const runStaging = async (what: string, run: () => Promise<void>): Promise<void> => {
    setFailure(null);
    try {
      await run();
    } catch (error) {
      setFailure(
        `${what} failed, and part of it may already have been applied. The lists below have been re-read from git. ${messageOf(error)}`,
      );
      await refreshStatus(store);
    }
  };

  const runDiscard = async (current: Pending): Promise<void> => {
    // Re-read the status as it is *now*, not as it was when the dialog opened.
    const latest = store.getState().status;
    if (latest.state !== 'ready') {
      // Not knowing is not the same as knowing there is nothing to discard.
      setPending({ ...current, notice: 'unchecked' });
      return;
    }

    const available = discardablePaths(latest);
    const stillThere = current.paths.filter((path) => available.has(path));
    if (stillThere.length !== current.paths.length) {
      if (stillThere.length === 0) {
        setPending(null);
        setFailure(
          'Those paths no longer have unstaged changes, so nothing was discarded.',
        );
      } else {
        // Recomputed, not narrowed: a path can have gained staged content while
        // the dialog was open, and the warning has to be true at confirm time.
        const stagedNow = new Set(pathsOfAll(groupEntries(latest.value.entries).staged));
        setPending({
          paths: stillThere,
          stagedToo: stillThere.filter((path) => stagedNow.has(path)),
          notice: 'changed',
        });
      }
      return;
    }

    setPending(null);
    setFailure(null);
    try {
      const result = await discard(store, current.paths, discardQuestion(current.paths));
      if (result === null) {
        // No repository, or nothing to discard: say so rather than imply a
        // stash exists that the user could pop.
        setFailure('Nothing was discarded, so there is nothing to recover.');
        return;
      }
      if (!result.discarded) {
        setFailure('Nothing was discarded, so there is nothing to recover.');
        return;
      }
      nextRecoveryId.current += 1;
      setRecoveries((previous) => [
        {
          id: nextRecoveryId.current,
          undoCommands: result.undoCommands,
          notes: result.notes ?? [],
          paths: current.paths,
        },
        ...previous,
      ]);
    } catch (error) {
      // An interrupted `git stash push` can have written the entry and still
      // reported failure. The error carries the recovery route in that case, so
      // it is shown verbatim rather than replaced with a guess.
      setFailure(
        `The discard did not finish. ${messageOf(error)} Check \`git stash list\` before retrying.`,
      );
    }
  };

  return (
    <section className={styles.panel} aria-label="Changes">
      {/*
        The recovery and failure notices live above the status switch on
        purpose: a status read that fails right after a discard must not take
        the only instructions for getting the work back off the screen.
      */}
      {recoveries.map((recovery) => (
        <RecoveryNotice
          key={recovery.id}
          recovery={recovery}
          onDismiss={() =>
            setRecoveries((previous) =>
              previous.filter((item) => item.id !== recovery.id),
            )
          }
        />
      ))}

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

      {pending !== null && (
        <DiscardConfirmation
          pending={pending}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void runDiscard(pending)}
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
          draft={draft}
          onDraft={setDraft}
          onStage={(paths) => void runStaging('Staging', () => stage(store, paths))}
          onUnstage={(paths) => void runStaging('Unstaging', () => unstage(store, paths))}
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
  draft,
  onDraft,
  onStage,
  onUnstage,
  onAskDiscard,
}: {
  groups: ReturnType<typeof groupEntries>;
  repoStatus: RepoStatus;
  busy: boolean;
  draft: CommitDraft;
  onDraft: (draft: CommitDraft) => void;
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
        draft={draft}
        onDraft={onDraft}
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
      <p className={styles.noticeText}>
        {recovery.undoCommands.length === 0
          ? partialRecoveryMessage()
          : recoveryMessage()}
      </p>
      {recovery.undoCommands.map((command) => (
        <pre key={command} className={styles.noticeCommand}>
          <code>{command}</code>
        </pre>
      ))}
      {recovery.notes.map((note) => (
        <p key={note} className={styles.warning}>
          {note}
        </p>
      ))}
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
  pending,
  busy,
  onCancel,
  onConfirm,
}: {
  pending: Pending;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactNode {
  const { paths, stagedToo, notice } = pending;
  const cancelRef = useRef<HTMLButtonElement>(null);

  // The safe choice takes focus, so a stray Enter cancels instead of discards.
  // Re-run on a re-ask: the list changed, so the user has to look again.
  useEffect(() => {
    cancelRef.current?.focus();
  }, [notice]);

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
      {notice === 'changed' && (
        <p className={styles.warning}>
          The working tree changed while this was open, so the list below is not what you
          first confirmed. Nothing has been discarded — review it and confirm again.
        </p>
      )}
      {notice === 'unchecked' && (
        <p className={styles.warning}>
          The working tree is being re-read, so this list could not be checked against it.
          Nothing has been discarded — try again in a moment.
        </p>
      )}
      <p className={styles.noticeText}>
        These working-tree changes will be removed from the files below. Krakenless
        stashes them first and then shows you the exact command that brings them back.
      </p>
      {stagedToo.length > 0 && (
        <p className={styles.warning}>
          {stagedToo.length === 1
            ? 'One of these paths also has staged changes.'
            : `${stagedToo.length} of these paths also have staged changes.`}{' '}
          The staged version is kept as it is — only the unstaged edits are discarded.
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
  draft,
  onDraft,
}: {
  stagedCount: number;
  hasConflicts: boolean;
  head: string | null;
  busy: boolean;
  draft: CommitDraft;
  onDraft: (draft: CommitDraft) => void;
}): ReactNode {
  const store = useStore();
  const { message, amend, error } = draft;

  const empty = message.trim().length === 0;
  const disabled = busy || empty || stagedCount === 0;
  // Amending mid-merge would rewrite a commit while the operation is still
  // running, and unlike a plain commit git would not stop it.
  const canAmend = !hasConflicts && head !== null;
  // What the button will actually do, so the flag sent to git can never differ
  // from the label the user read.
  const amending = amend && canAmend;

  const submit = async (): Promise<void> => {
    if (store.getState().repo.state !== 'ready') {
      onDraft({ ...draft, error: 'No repository is open.' });
      return;
    }
    onDraft({ ...draft, error: null });
    try {
      await commitStaged(store, { message, amend: amending });
      onDraft({ message: '', amend: false, error: null });
    } catch (failure) {
      onDraft({ ...draft, error: messageOf(failure) });
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
        onChange={(event) => onDraft({ ...draft, message: event.target.value })}
      />

      <label className={styles.amend}>
        <input
          type="checkbox"
          checked={amending}
          disabled={busy || !canAmend}
          onChange={(event) => onDraft({ ...draft, amend: event.target.checked })}
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
      {amending && (
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
          {amending ? 'Amend commit' : 'Commit'}
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
