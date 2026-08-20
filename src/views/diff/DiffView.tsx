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
import { useAppState, useStore } from '../../state/hooks';
import { FileEditor } from './FileEditor';
import styles from './DiffView.module.css';
import {
  CHANGE_KIND_LABELS,
  countLines,
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
          <li key={file.newPath}>
            <button
              type="button"
              className={styles.fileButton}
              aria-current={selectedPath === file.newPath ? 'true' : undefined}
              onClick={() => onSelect(file.newPath)}
            >
              <span className={styles.filePath}>{displayPath(file)}</span>
              <span className={styles.fileKind}>{CHANGE_KIND_LABELS[file.kind]}</span>
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
}: {
  files: FileDiff[];
  selectedPath: string | null;
  editable: boolean;
  editing: string | null;
  onEdit: (path: string | null) => void;
}): ReactNode {
  const shown =
    selectedPath === null ? files : files.filter((f) => f.newPath === selectedPath);

  if (shown.length === 0) {
    return (
      <div className={styles.content}>
        <Notice title="File not in this diff">
          {`"${selectedPath ?? ''}" is not part of the current selection. Pick a file from the list.`}
        </Notice>
      </div>
    );
  }

  return (
    <div className={styles.content}>
      {shown.map((file) => (
        <FileDiffBlock
          key={file.newPath}
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

  return (
    <article className={styles.file} aria-label={displayPath(file)}>
      <header className={styles.fileHeader}>
        <span className={styles.filePath}>{displayPath(file)}</span>
        <span className={styles.fileKind}>{CHANGE_KIND_LABELS[file.kind]}</span>
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
        file.hunks.map((hunk, index) => <HunkBlock key={index} hunk={hunk} />)
      ) : (
        <p className={styles.fileNote}>{note}</p>
      )}
    </article>
  );
}

function HunkBlock({ hunk }: { hunk: Hunk }): ReactNode {
  return (
    <div className={styles.hunk}>
      <div className={styles.hunkHeader}>{hunk.header}</div>
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
