/**
 * Read-only diff panel.
 *
 * The panel never renders a blank body: every shape git can hand us — binary,
 * conflicted, mode-only, pure rename, empty new file — gets a sentence saying
 * what it is. A blank area would read as "no changes", and a user who trusts
 * that reading can stage or discard something they never actually saw.
 */

import { useState, type ReactNode } from 'react';
import type { DiffLine, FileDiff, Hunk } from '../../git/types';
import { discardHunk, stageHunks } from '../../state/actions';
import { useAppState, useStore } from '../../state/hooks';
import { isBusy } from '../../state/store';
import { FileEditor } from './FileEditor';
import {
  discardHunkQuestion,
  hunkActionBlocker,
  hunkActions,
  type HunkAction,
} from './hunkActions';
import styles from './DiffView.module.css';
import {
  CHANGE_KIND_LABELS,
  countLines,
  DIFF_SIDE_LABELS,
  displayPath,
  emptyBodyReason,
  LINE_KIND_LABELS,
  LINE_MARKERS,
} from './labels';

/** Diff panel for the current selection. Reads the store, writes only selection. */
export function DiffView(): ReactNode {
  const diff = useAppState((state) => state.diff);
  const selectedPath = useAppState((state) => state.selection.path);
  // Only the working tree is editable: a commit's version of a file is history,
  // and there is nothing on disk to write it back to.
  const editable = useAppState((state) => state.selection.commitOid === null);
  // `git diff` reports nothing for an untracked file — there is no earlier
  // version — so a path selected from the working-tree panel can legitimately
  // be missing from this diff. The status is the only thing that can tell that
  // case apart from a stale selection.
  const untrackedPath = useAppState((state) => {
    const path = state.selection.path;
    if (path === null || state.status.state !== 'ready') return false;
    return state.status.value.entries.some(
      (entry) => entry.path === path && entry.worktree === 'untracked',
    );
  });
  const store = useStore();
  const [editing, setEditing] = useState<string | null>(null);

  const selectPath = (path: string | null): void => {
    store.dispatch({ type: 'selection/path', path });
  };

  return (
    <section className={styles.panel} aria-label="Diff">
      {diff.state === 'idle' && (
        <Notice title="No diff to show">
          Select a commit or the working tree to see its changes.
        </Notice>
      )}

      {diff.state === 'loading' && (
        <Notice title="Loading diff…">Reading changes from git.</Notice>
      )}

      {diff.state === 'error' && <DiffError message={diff.message} kind={diff.kind} />}

      {diff.state === 'ready' && diff.value.length === 0 && (
        <Notice title="No changes">Nothing differs in this selection.</Notice>
      )}

      {diff.state === 'ready' && diff.value.length > 0 && (
        <div className={styles.body}>
          <FileList
            files={diff.value}
            selectedPath={selectedPath}
            onSelect={selectPath}
          />
          <FileDiffs
            files={diff.value}
            selectedPath={selectedPath}
            editable={editable}
            editing={editing}
            onEdit={setEditing}
            untracked={untrackedPath}
          />
        </div>
      )}
    </section>
  );
}

function DiffError({ message, kind }: { message: string; kind?: string }): ReactNode {
  if (kind === 'undecodable-output') {
    return (
      <Notice title="Diff cannot be shown safely" tone="error">
        The file&apos;s bytes are not valid UTF-8, so this diff cannot be decoded without
        corrupting it. Krakenless will not show a mangled diff you might act on. Details:{' '}
        {message}
      </Notice>
    );
  }
  return (
    <Notice title="Could not load the diff" tone="error">
      {message}
    </Notice>
  );
}

function Notice({
  title,
  tone = 'neutral',
  children,
}: {
  title: string;
  tone?: 'neutral' | 'error';
  children: ReactNode;
}): ReactNode {
  return (
    <div
      className={
        tone === 'error' ? `${styles.notice} ${styles.noticeError}` : styles.notice
      }
      role={tone === 'error' ? 'alert' : undefined}
    >
      <strong className={styles.noticeTitle}>{title}</strong>
      <p className={styles.noticeText}>{children}</p>
    </div>
  );
}

function FileList({
  files,
  selectedPath,
  onSelect,
}: {
  files: FileDiff[];
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
}): ReactNode {
  return (
    <nav className={styles.files} aria-label="Changed files">
      <ul className={styles.fileList}>
        <li>
          <button
            type="button"
            className={styles.fileButton}
            aria-current={selectedPath === null ? 'true' : undefined}
            onClick={() => onSelect(null)}
          >
            <span className={styles.filePath}>All files ({files.length})</span>
          </button>
        </li>
        {files.map((file) => (
          <li key={`${file.side}:${file.newPath}`}>
            <button
              type="button"
              className={styles.fileButton}
              aria-current={selectedPath === file.newPath ? 'true' : undefined}
              onClick={() => onSelect(file.newPath)}
            >
              <span className={styles.filePath}>{displayPath(file)}</span>
              <span className={styles.fileKind}>{CHANGE_KIND_LABELS[file.kind]}</span>
              {/*
                The worktree and cached diffs are concatenated, so the same path
                can be listed twice. Without this the two rows are identical and
                the user cannot tell which one their buttons will act on.
              */}
              <span className={styles.fileSide}>{DIFF_SIDE_LABELS[file.side]}</span>
              <FileCounts file={file} />
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function FileCounts({ file }: { file: FileDiff }): ReactNode {
  const { added, deleted } = countLines(file);
  return (
    <span className={styles.counts}>
      <span className={styles.added}>{`+${added}`}</span>
      <span className={styles.deleted}>{`-${deleted}`}</span>
    </span>
  );
}

function FileDiffs({
  files,
  selectedPath,
  editable,
  editing,
  onEdit,
  untracked,
}: {
  files: FileDiff[];
  selectedPath: string | null;
  editable: boolean;
  editing: string | null;
  onEdit: (path: string | null) => void;
  /** True when the selected path is a file git does not track yet. */
  untracked: boolean;
}): ReactNode {
  const shown =
    selectedPath === null ? files : files.filter((f) => f.newPath === selectedPath);

  if (shown.length === 0) {
    return (
      <div className={styles.content}>
        <Notice title={untracked ? 'Nothing to diff yet' : 'File not in this diff'}>
          {untracked
            ? // Reachable from the working-tree panel, where untracked files are
              // listed next to modified ones and look equally clickable. Git has
              // no previous version to compare against, so `git diff` says
              // nothing about them — which is a different problem from "wrong
              // selection", and needs a different next step.
              `"${selectedPath ?? ''}" is not tracked by git yet, so there is no earlier version to compare it against. Stage it to see its contents as a diff.`
            : `"${selectedPath ?? ''}" is not part of the current selection. Pick a file from the list.`}
        </Notice>
      </div>
    );
  }

  return (
    <div className={styles.content}>
      {shown.map((file) => (
        <FileDiffBlock
          key={`${file.side}:${file.newPath}`}
          file={file}
          editable={editable}
          editing={editing === file.newPath}
          onEdit={onEdit}
        />
      ))}
    </div>
  );
}

function FileDiffBlock({
  file,
  editable,
  editing,
  onEdit,
}: {
  file: FileDiff;
  editable: boolean;
  editing: boolean;
  onEdit: (path: string | null) => void;
}): ReactNode {
  const note = emptyBodyReason(file);
  // A deleted file has nothing on disk to open; the rest are edited at their
  // current path, which for a rename is the new one.
  const canEdit = editable && file.kind !== 'deleted';
  // Said once above the hunks rather than repeated on every one of them, and
  // only when there are hunks a user would otherwise expect buttons on.
  const blocker = file.side === 'commit' ? null : hunkActionBlocker(file);

  return (
    <article className={styles.file} aria-label={displayPath(file)}>
      <header className={styles.fileHeader}>
        <span className={styles.filePath}>{displayPath(file)}</span>
        <span className={styles.fileKind}>{CHANGE_KIND_LABELS[file.kind]}</span>
        <span className={styles.fileSide}>{DIFF_SIDE_LABELS[file.side]}</span>
        {canEdit && !editing && (
          <button
            type="button"
            className={styles.editButton}
            onClick={() => onEdit(file.newPath)}
          >
            Edit
          </button>
        )}
      </header>

      {editing ? (
        <FileEditor key={file.newPath} path={file.newPath} onClose={() => onEdit(null)} />
      ) : note === null ? (
        <>
          {blocker !== null && file.hunks.length > 0 && (
            <p className={styles.fileNote}>{blocker}</p>
          )}
          {file.hunks.map((hunk, index) => (
            <HunkBlock key={index} file={file} hunk={hunk} />
          ))}
        </>
      ) : (
        <p className={styles.fileNote}>{note}</p>
      )}
    </article>
  );
}

function HunkBlock({ file, hunk }: { file: FileDiff; hunk: Hunk }): ReactNode {
  const store = useStore();
  const busy = useAppState(isBusy);
  const [confirming, setConfirming] = useState(false);
  const actions = hunkActions(file);

  const run = (action: HunkAction): void => {
    if (action === 'discard') {
      setConfirming(true);
      return;
    }
    void stageHunks(store, file, [hunk], { reverse: action === 'unstage' });
  };

  return (
    <div className={styles.hunk}>
      <div className={styles.hunkHeader}>
        <span className={styles.hunkRange}>{hunk.header}</span>
        {actions.length > 0 && (
          <span className={styles.hunkActions}>
            {actions.map((spec) => (
              <button
                key={spec.action}
                type="button"
                className={spec.danger ? styles.hunkDanger : styles.hunkAction}
                disabled={busy}
                // The header alone does not say which file, and the same hunk
                // range exists in every other file on screen.
                aria-label={`${spec.label} of ${file.newPath}, ${hunk.header}`}
                onClick={() => {
                  run(spec.action);
                }}
              >
                {spec.label}
              </button>
            ))}
          </span>
        )}
      </div>

      {confirming && (
        <ConfirmDiscardHunk
          question={discardHunkQuestion(file.newPath, hunk.header)}
          busy={busy}
          onCancel={() => {
            setConfirming(false);
          }}
          onConfirm={() => {
            setConfirming(false);
            void discardHunk(
              store,
              file,
              [hunk],
              discardHunkQuestion(file.newPath, hunk.header),
            );
          }}
        />
      )}
      <div className={styles.lines}>
        {hunk.lines.map((line, index) => (
          <div
            key={index}
            className={`${styles.line} ${lineClass(line.kind)}`}
            data-kind={line.kind}
            data-old-line={line.oldLine ?? ''}
            data-new-line={line.newLine ?? ''}
          >
            <span className={styles.srOnly}>{`${LINE_KIND_LABELS[line.kind]}: `}</span>
            <span className={styles.lineNumber} data-side="old">
              {line.oldLine ?? ''}
            </span>
            <span className={styles.lineNumber} data-side="new">
              {line.newLine ?? ''}
            </span>
            <span className={styles.marker} aria-hidden="true">
              {LINE_MARKERS[line.kind]}
            </span>
            <span className={styles.lineText}>{line.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The one destructive control in this panel, so it asks in full sentences and
 * defaults to Cancel. Inline rather than a modal: the hunk it is about has to
 * stay on screen while the question is being read.
 */
function ConfirmDiscardHunk({
  question,
  busy,
  onCancel,
  onConfirm,
}: {
  question: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactNode {
  return (
    <div className={styles.confirm} role="alertdialog" aria-label="Confirm discard hunk">
      <p className={styles.confirmText}>{question}</p>
      <div className={styles.confirmButtons}>
        <button type="button" className={styles.hunkAction} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className={styles.hunkDanger}
          disabled={busy}
          onClick={onConfirm}
        >
          Discard hunk
        </button>
      </div>
    </div>
  );
}

function lineClass(kind: DiffLine['kind']): string | undefined {
  switch (kind) {
    case 'added':
      return styles.lineAdded;
    case 'deleted':
      return styles.lineDeleted;
    case 'no-newline':
      return styles.lineNoNewline;
    case 'context':
      return styles.lineContext;
  }
}
