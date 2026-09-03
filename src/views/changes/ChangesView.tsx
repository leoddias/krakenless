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
import { revealPath } from '../../config/launch';
import { deleteWorktreeFile } from '../../fs/file';
import { readHeadMessage } from '../../git/log';
import type { RepoStatus, StatusEntry } from '../../git/types';
import {
  commitStaged,
  discard,
  refreshStatus,
  selectCommit,
  stage,
  suggestCommitMessage,
  unstage,
} from '../../state/actions';
import { useAppState, useStore } from '../../state/hooks';
import { isBusy } from '../../state/store';
import type { Loadable } from '../../state/store';
import { ContextMenu, type MenuSection } from '../shell/ContextMenu';
import { copyText } from '../shell/clipboard';
import { OperationPanel } from './OperationPanel';
import {
  buildFileMenu,
  deleteCost,
  deleteQuestion,
  type DeleteCost,
  type FileAction,
} from './fileMenu';
import {
  EMPTY_SELECTION,
  nextSelection,
  pruneSelection,
  selectedInOrder,
  type Selection,
} from './multiSelect';
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

/** A delete waiting on its confirmation, and what it would cost. */
interface PendingDelete {
  paths: string[];
  cost: DeleteCost;
}

/** Where a file context menu was opened, and on which rows. */
interface FileMenuTarget {
  entries: StatusEntry[];
  /** Viewport coordinates of the right-click. */
  x: number;
  y: number;
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
  const selectedPath = useAppState((state) => state.selection.path);
  // A bare repository has no working tree, and `root` aliases the git
  // directory there — never a path to hand a file manager or a delete.
  const repoRoot = useAppState((state) =>
    state.repo.state === 'ready' && !state.repo.value.bare ? state.repo.value.root : null,
  );
  const store = useStore();

  const [pending, setPending] = useState<Pending | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [menu, setMenu] = useState<FileMenuTarget | null>(null);
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

  /**
   * Narrows the diff panel to one file from this list.
   *
   * The history may have a commit selected, in which case the diff below is
   * that commit's and a working-tree path means nothing in it. So the working
   * tree is selected first — `selectCommit` dispatches that synchronously
   * before it awaits anything, and it clears the path, which is why the path is
   * set after rather than before.
   */
  const showInDiff = (path: string): void => {
    if (store.getState().selection.commitOid !== null) void selectCommit(store, null);
    store.dispatch({ type: 'selection/path', path });
  };

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
    // `stale` counts as not knowing: a re-read that is still running is
    // showing the previous answer, and discarding against an answer that is
    // already known to be out of date is exactly the case this guard exists
    // for. Only a settled status can authorise taking work off disk.
    if (latest.state !== 'ready' || latest.stale === true) {
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

  /**
   * Carries out what the context menu was asked for.
   *
   * Both writes stop here rather than running: a discard goes through the same
   * confirmation the row button uses, and a delete opens its own. The two reads
   * — copy and reveal — run immediately, and both report their own failure,
   * because a copy that did not happen is only discovered at the next paste.
   */
  const runMenuAction = (action: FileAction, entries: StatusEntry[]): void => {
    switch (action.kind) {
      case 'discard':
        askDiscard(action.paths);
        return;
      case 'delete':
        setFailure(null);
        setPendingDelete({
          paths: action.paths,
          cost: deleteCost(entries.filter((entry) => action.paths.includes(entry.path))),
        });
        return;
      case 'reveal':
        void revealPath(action.path).catch((error: unknown) => {
          setFailure(`Could not open the file manager. ${messageOf(error)}`);
        });
        return;
      case 'copy':
        void copyText(action.text).then(
          (copied) => {
            if (!copied) setFailure(`The ${action.what} could not be copied.`);
          },
          (error: unknown) => {
            setFailure(`The ${action.what} could not be copied. ${messageOf(error)}`);
          },
        );
        return;
    }
  };

  /**
   * Deletes the confirmed files, one at a time, and says what survived.
   *
   * One `await` per file rather than a batch: a failure halfway through a batch
   * leaves the user with no idea which files are gone. Every path is attempted
   * even after one fails, and the status is re-read afterwards whatever
   * happened — the lists are the only place the user can check.
   */
  const runDelete = async (current: PendingDelete): Promise<void> => {
    setPendingDelete(null);
    setFailure(null);
    if (repoRoot === null) {
      setFailure('The repository path is not known, so nothing was deleted.');
      return;
    }

    const failed: string[] = [];
    let firstReason: string | null = null;
    for (const path of current.paths) {
      try {
        await deleteWorktreeFile(repoRoot, path);
      } catch (error) {
        failed.push(path);
        firstReason ??= messageOf(error);
      }
    }

    await refreshStatus(store);
    if (failed.length > 0) {
      setFailure(
        `${failed.length === current.paths.length ? 'Nothing was deleted' : `${String(failed.length)} of ${String(current.paths.length)} files were not deleted`}: ${failed.join(', ')}. ${firstReason ?? ''}`,
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

      {pendingDelete !== null && (
        <DeleteConfirmation
          pending={pendingDelete}
          busy={busy}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void runDelete(pendingDelete)}
        />
      )}

      {menu !== null && (
        <FileMenu
          target={menu}
          root={repoRoot}
          busy={busy}
          discardable={discardablePaths(status)}
          onChoose={runMenuAction}
          onClose={() => setMenu(null)}
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
          onOpenMenu={setMenu}
          selectedPath={selectedPath}
          onShowDiff={showInDiff}
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
  onOpenMenu,
  selectedPath,
  onShowDiff,
}: {
  groups: ReturnType<typeof groupEntries>;
  repoStatus: RepoStatus;
  busy: boolean;
  draft: CommitDraft;
  onDraft: (draft: CommitDraft) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onAskDiscard: (paths: string[]) => void;
  onOpenMenu: (target: FileMenuTarget) => void;
  selectedPath: string | null;
  onShowDiff: (path: string) => void;
}): ReactNode {
  const { staged, unstaged, conflicted } = groups;
  const operation = useAppState((state) => state.operation);
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

      {/*
        Unstaged first. It is the list being worked *from* — files arrive there
        and are picked out of it — while the staged list is what the commit box
        directly underneath is about, so the two that belong together are
        adjacent.
      */}
      <FileSection
        title="Unstaged"
        entries={unstaged}
        side="worktree"
        emptyText="No unstaged changes."
        bulkLabel="Stage all"
        selectionLabel="Stage"
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
        onOpenMenu={onOpenMenu}
        selectedPath={selectedPath}
        onShowDiff={onShowDiff}
      />

      <FileSection
        title="Staged"
        entries={staged}
        side="index"
        emptyText="Nothing staged yet."
        bulkLabel="Unstage all"
        selectionLabel="Unstage"
        busy={busy}
        onBulk={onUnstage}
        rowActions={(entry) => [
          { label: 'Unstage', run: () => onUnstage(pathsOf(entry)) },
        ]}
        onOpenMenu={onOpenMenu}
        selectedPath={selectedPath}
        onShowDiff={onShowDiff}
      />

      {/*
        One or the other, never both. While a rebase is stopped the commit box
        is a trap: git makes the commit itself when the rebase resumes, and a
        commit made by hand here lands on a detached HEAD.
      */}
      {operation.kind === null || operation.kind === 'merge' ? (
        <>
          {operation.kind === 'merge' && <OperationPanel />}
          <CommitBox
            stagedCount={staged.length}
            hasConflicts={repoStatus.hasConflicts || conflicted.length > 0}
            head={repoStatus.head}
            busy={busy}
            draft={draft}
            onDraft={onDraft}
          />
        </>
      ) : (
        <OperationPanel />
      )}
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

/**
 * The context menu for one or more working-tree rows.
 *
 * Thin on purpose: which items exist, and which of them may run, is decided in
 * `fileMenu.ts` where it can be asserted. This turns that answer into the menu
 * the shell already knows how to draw, and hands the chosen action back with
 * the rows it was built from — so a delete confirmation can say what each of
 * those rows would cost even after the menu is gone.
 */
function FileMenu({
  target,
  root,
  busy,
  discardable,
  onChoose,
  onClose,
}: {
  target: FileMenuTarget;
  root: string | null;
  busy: boolean;
  discardable: ReadonlySet<string>;
  onChoose: (action: FileAction, entries: StatusEntry[]) => void;
  onClose: () => void;
}): ReactNode {
  const sections: MenuSection[] = buildFileMenu({
    entries: target.entries,
    root,
    busy,
    discardable,
  }).map((section) =>
    section.map((item) => ({
      id: item.id,
      label: item.label,
      disabled: item.disabled,
      ...(item.action === undefined
        ? {}
        : { onSelect: () => onChoose(item.action as FileAction, target.entries) }),
    })),
  );

  const first = target.entries[0];
  const label =
    target.entries.length === 1 && first !== undefined
      ? `Actions for ${first.path}`
      : `Actions for ${String(target.entries.length)} files`;

  return (
    <ContextMenu
      sections={sections}
      x={target.x}
      y={target.y}
      label={label}
      onClose={onClose}
    />
  );
}

/**
 * The question asked before files leave the disk.
 *
 * Discard has a stash behind it and can promise the work back; this cannot
 * promise anything, so it says exactly what git would still hold and what it
 * would not. Untracked files are called out separately because they are the
 * only ones whose contents exist nowhere else in the world.
 */
function DeleteConfirmation({
  pending,
  busy,
  onCancel,
  onConfirm,
}: {
  pending: PendingDelete;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactNode {
  const { paths, cost } = pending;
  const cancelRef = useRef<HTMLButtonElement>(null);

  // The safe choice takes focus, so a stray Enter cancels instead of deletes.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <div
      className={styles.confirm}
      role="alertdialog"
      aria-label="Confirm delete"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <strong className={styles.noticeTitle}>{deleteQuestion(paths)}</strong>
      <p className={styles.noticeText}>
        These files are removed from disk. This is not a discard: Krakenless keeps no
        stash of them, and nothing here puts them back.
      </p>
      {cost.untracked.length > 0 && (
        <p className={styles.warning}>
          {cost.untracked.length === 1
            ? 'One of these is untracked, so git has never seen its contents.'
            : `${String(cost.untracked.length)} of these are untracked, so git has never seen their contents.`}{' '}
          Nothing in the repository can bring them back.
        </p>
      )}
      {cost.tracked.length > 0 && (
        <p className={styles.noticeText}>
          The committed version of the tracked files stays in the repository — `git
          restore` brings those back — but any change since the last commit goes with the
          file.
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
          {paths.length === 1 ? 'Delete 1 file' : `Delete ${String(paths.length)} files`}
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
  selectionLabel,
  secondaryBulk,
  busy,
  onBulk,
  rowActions,
  onOpenMenu,
  selectedPath,
  onShowDiff,
}: {
  title: string;
  entries: StatusEntry[];
  side: 'index' | 'worktree';
  emptyText: string;
  bulkLabel: string;
  /** Verb for the action on a multi-file selection: "Stage", "Unstage". */
  selectionLabel: string;
  secondaryBulk?: { label: string; danger?: boolean; run: (paths: string[]) => void };
  busy: boolean;
  onBulk: (paths: string[]) => void;
  rowActions: (entry: StatusEntry) => RowAction[];
  onOpenMenu: (target: FileMenuTarget) => void;
  /** Path the diff panel is currently narrowed to, so the row can show it. */
  selectedPath: string | null;
  onShowDiff: (path: string) => void;
}): ReactNode {
  const paths = pathsOfAll(entries);
  const label = `${title} (${entries.length})`;

  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  // Pruned on the way out rather than in an effect: the list changes under the
  // selection constantly — staging moves a file to the other section — and a
  // selection holding rows nobody can see must never reach a bulk action.
  // `pruneSelection` returns the same object when nothing changed, so this is
  // free on the ordinary render.
  const live = pruneSelection(paths, selection);
  const chosen = selectedInOrder(paths, live);
  const multiple = chosen.length > 1;

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
          {/* Only once there are two: with one file selected the row's own
              button is right there, and a second control saying the same thing
              is clutter. */}
          {multiple && (
            <button
              type="button"
              className={styles.button}
              disabled={busy}
              onClick={() => {
                onBulk(chosen);
                setSelection(EMPTY_SELECTION);
              }}
            >
              {`${selectionLabel} ${String(chosen.length)} selected`}
            </button>
          )}
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
            <li
              key={entry.path}
              className={
                live.paths.has(entry.path) || entry.path === selectedPath
                  ? `${styles.row} ${styles.rowSelected}`
                  : styles.row
              }
              /*
                Right-click acts on the selection when the clicked row is part
                of it, and on that row alone otherwise — the rule every file
                list uses. Acting on the selection regardless would let a
                right-click on an unselected file delete files elsewhere in the
                list; replacing the selection would throw away work the user
                spent ten shift-clicks building.
              */
              onContextMenu={(event) => {
                event.preventDefault();
                const target =
                  live.paths.has(entry.path) && live.paths.size > 1
                    ? entries.filter((candidate) => live.paths.has(candidate.path))
                    : [entry];
                onOpenMenu({ entries: target, x: event.clientX, y: event.clientY });
              }}
            >
              <span className={styles.state} title={STATE_LABELS[entry[side]]}>
                {STATE_LETTERS[entry[side]]}
              </span>
              {/* The path is the way into the diff, not decoration: clicking a
                  file here is how a user asks "what changed in this one?", and
                  before this it was a label you could not press. */}
              <button
                type="button"
                className={styles.path}
                aria-current={entry.path === selectedPath ? 'true' : undefined}
                title={`Show the diff for ${entry.path}. Shift-click to select a range; Ctrl or Cmd click to add one.`}
                onClick={(event) => {
                  setSelection(
                    nextSelection(paths, live, {
                      path: entry.path,
                      shift: event.shiftKey,
                      toggle: event.ctrlKey || event.metaKey,
                    }),
                  );
                  // The diff follows the row that was clicked, whatever the
                  // modifiers did to the selection: it is the one the user
                  // just pointed at.
                  onShowDiff(entry.path);
                }}
              >
                {displayPath(entry)}
              </button>
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
  const store = useStore();
  const busy = useAppState(isBusy);

  return (
    <section className={styles.section} aria-label="Conflicted">
      <header className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>{`Conflicted (${entries.length})`}</h2>
      </header>
      <p className={styles.conflictNote}>
        Click a file to resolve it side by side. An unmerged path is never staged or
        discarded as it stands: staging it would record the conflict markers as the
        resolution.
      </p>
      <ul className={styles.list}>
        {entries.map((entry) => (
          <li key={entry.path} className={`${styles.row} ${styles.conflictRow}`}>
            <span className={styles.state} title={STATE_LABELS.unmerged}>
              {STATE_LETTERS.unmerged}
            </span>
            {/*
              The row is the way in. Clicking a conflicted file is the first
              thing anybody tries, and it used to do nothing at all.
            */}
            <button
              type="button"
              className={styles.conflictOpen}
              disabled={busy}
              title={`Resolve ${entry.path} side by side`}
              onClick={() => store.dispatch({ type: 'resolve/open', path: entry.path })}
            >
              <span className={styles.path}>{displayPath(entry)}</span>
            </button>
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
  const aiCommand = useAppState((state) => state.config.aiCommand).trim();
  const [suggesting, setSuggesting] = useState(false);
  const [aiNote, setAiNote] = useState<string | null>(null);
  /**
   * The message this box filled in from the last commit, while it is untouched.
   *
   * Ticking Amend loads that commit's message, because an amend replaces it
   * wholesale — leaving the box empty asked the user to retype a message git
   * already has, and made the button refuse to do anything until they did.
   * Unticking puts the box back to empty, but only if this is still exactly
   * what was loaded: once a word has been changed it is the user's draft, and
   * theirs to keep.
   */
  const loadedMessage = useRef<string | null>(null);
  // The draft as of this render, for the callback that resumes after an await:
  // the box can have been typed into while git was answering.
  const latest = useRef(draft);
  latest.current = draft;

  const empty = message.trim().length === 0;
  // Amending mid-merge would rewrite a commit while the operation is still
  // running, and unlike a plain commit git would not stop it.
  const canAmend = !hasConflicts && head !== null;
  // What the button will actually do, so the flag sent to git can never differ
  // from the label the user read.
  const amending = amend && canAmend;
  // An amend with nothing staged is a real operation — it rewrites the last
  // commit's message — so only a plain commit needs something to commit.
  const disabled = busy || empty || (stagedCount === 0 && !amending);

  /**
   * Ticks or unticks Amend, carrying the last commit's message with it.
   *
   * The read failing is not worth an error: the box is simply left as it was,
   * and the user can type. Nothing about the amend itself depends on it.
   */
  const toggleAmend = async (checked: boolean): Promise<void> => {
    if (!checked) {
      const untouched =
        loadedMessage.current !== null && message === loadedMessage.current;
      loadedMessage.current = null;
      onDraft({ ...draft, amend: false, message: untouched ? '' : message });
      return;
    }
    onDraft({ ...draft, amend: true });
    // A draft already written is an answer; it is not replaced by the old one.
    if (!empty) return;
    const repo = store.getState().repo;
    if (repo.state !== 'ready') return;
    try {
      const previous = await readHeadMessage(repo.value.root);
      if (previous === null || previous.length === 0) return;
      const now = latest.current;
      // Still the same empty box, still amending: anything else means the user
      // has moved on, and their state wins.
      if (!now.amend || now.message.trim().length > 0) return;
      loadedMessage.current = previous;
      onDraft({ ...now, message: previous });
    } catch {
      // Left as it was; the box is still typeable and Amend still works.
    }
  };

  /**
   * Fills the box; never commits. A model's sentence about someone's code is a
   * draft, and the person pressing Commit is the one who decides it is true.
   */
  const suggest = async (): Promise<void> => {
    setSuggesting(true);
    setAiNote(null);
    onDraft({ ...draft, error: null });
    try {
      const result = await suggestCommitMessage(store);
      onDraft({ ...draft, message: result.message, error: null });
      if (result.kind === 'summary') {
        // Said out loud rather than hidden: the message was written from the
        // file list, not the code, and the user should weigh it accordingly.
        setAiNote(
          'The staged diff was too large to send whole, so this was written from the list of changed files.',
        );
      }
    } catch (failure) {
      onDraft({ ...draft, error: messageOf(failure) });
    } finally {
      setSuggesting(false);
    }
  };

  const submit = async (): Promise<void> => {
    if (store.getState().repo.state !== 'ready') {
      onDraft({ ...draft, error: 'No repository is open.' });
      return;
    }
    onDraft({ ...draft, error: null });
    try {
      await commitStaged(store, { message, amend: amending });
      loadedMessage.current = null;
      onDraft({ message: '', amend: false, error: null });
    } catch (failure) {
      onDraft({ ...draft, error: `Commit failed: ${messageOf(failure)}` });
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
          onChange={(event) => void toggleAmend(event.target.checked)}
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

      {aiNote !== null && (
        <p className={styles.commitHint} role="status">
          {aiNote}
        </p>
      )}

      {error !== null && (
        <p className={styles.commitError} role="alert">
          {error}
        </p>
      )}

      <div className={styles.commitActions}>
        <span className={styles.commitHint}>
          {commitHint(stagedCount, empty, amending)}
        </span>
        <button
          type="button"
          className={styles.button}
          disabled={busy || suggesting || stagedCount === 0 || aiCommand.length === 0}
          title={aiTitle(aiCommand, stagedCount, message)}
          onClick={() => void suggest()}
        >
          {suggesting ? 'Writing…' : 'AI Commit'}
        </button>
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

/**
 * Why the AI button is off, or what it will do. The command name is in the
 * text because it is what the user configured and what will receive their
 * staged diff.
 */
function aiTitle(command: string, stagedCount: number, message: string): string {
  if (command.length === 0) {
    return 'Set an AI command in Settings to use this.';
  }
  if (stagedCount === 0) {
    return 'Stage something first: the message is written from the staged diff.';
  }
  const replacing =
    message.trim().length > 0 ? ' This replaces what you have typed.' : '';
  return `Send the staged diff to "${command}" and write a commit message from it.${replacing}`;
}

/** Says why the button is off, instead of leaving a dead control on screen. */
function commitHint(
  stagedCount: number,
  emptyMessage: boolean,
  amending: boolean,
): string {
  // Nothing staged is only a problem for a plain commit. An amend with an empty
  // index rewrites the last commit's message, which is most of what people
  // amend for, so saying "stage a file first" there was simply wrong.
  if (stagedCount === 0 && !amending) return 'Stage at least one file to commit.';
  if (emptyMessage) return 'Write a commit message to commit.';
  if (amending) {
    return stagedCount === 0
      ? 'Nothing staged: this rewrites the last commit’s message.'
      : `${String(stagedCount)} file${stagedCount === 1 ? '' : 's'} staged; they join the last commit.`;
  }
  return stagedCount === 1 ? '1 file staged.' : `${String(stagedCount)} files staged.`;
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
