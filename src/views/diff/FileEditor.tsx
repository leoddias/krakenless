/**
 * Editing a working-tree file in place.
 *
 * The rules that shape this component are all about not losing text:
 *
 * - It only ever edits the *working tree*. A file as it was in some commit is
 *   history; there is nothing on disk to write it back to.
 * - The file's own line endings, byte-order mark and trailing newline are
 *   restored on save (see `fs/text.ts`), so a one-word edit stays a one-word
 *   diff instead of rewriting every line.
 * - A save carries the fingerprint of the bytes it read. If the file changed on
 *   disk underneath the editor — a rebase, a build step, another editor — the
 *   write is refused and the user is told, rather than the other change being
 *   overwritten.
 * - Closing an editor with unsaved text asks first. It is the only unsaved
 *   state in the app.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FileError, type OpenFile } from '../../fs/file';
import { fromEditor } from '../../fs/text';
import { openFileForEdit, saveEditedFile } from '../../state/actions';
import { useAppState, useStore } from '../../state/hooks';
import { isBusy } from '../../state/store';
import styles from './DiffView.module.css';

type Phase =
  | { state: 'loading' }
  | { state: 'ready'; file: OpenFile }
  | { state: 'failed'; message: string };

/** What went wrong, in words that say what to do about it. */
function explain(error: unknown): string {
  if (error instanceof FileError) {
    switch (error.kind) {
      case 'changed-on-disk':
        return `This file changed on disk after you opened it here, so Krakenless did not overwrite it. Your text is still on screen — copy anything you need, then close the editor and open it again to see the current file.`;
      case 'not-found':
        return 'This file is no longer in the working tree. It may have been deleted, renamed, or a branch switch replaced it.';
      case 'too-large':
      case 'not-editable':
      case 'bad-request':
      case 'outside-repo':
        return error.message;
      default:
        return `${error.message} Nothing was written.`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export function FileEditor({
  path,
  onClose,
}: {
  path: string;
  onClose: () => void;
}): ReactNode {
  const store = useStore();
  const busy = useAppState(isBusy);
  // The component is keyed by path at the call site, so a different file gets
  // a fresh instance rather than this one resetting itself in an effect.
  const [phase, setPhase] = useState<Phase>({ state: 'loading' });
  const [draft, setDraft] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const area = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void openFileForEdit(store, path)
      .then((file) => {
        if (cancelled) return;
        setPhase({ state: 'ready', file });
        setDraft(file.text);
      })
      .catch((error: unknown) => {
        if (!cancelled) setPhase({ state: 'failed', message: explain(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [store, path]);

  // Focus lands in the text, not on the first button: the user asked to edit.
  useEffect(() => {
    if (phase.state === 'ready') area.current?.focus();
  }, [phase.state]);

  if (phase.state === 'loading') {
    return (
      <div className={styles.editor}>
        <p className={styles.editorNote} role="status">
          Opening {path}…
        </p>
      </div>
    );
  }

  if (phase.state === 'failed') {
    return (
      <div className={styles.editor}>
        <p className={styles.editorFailure} role="alert">
          {phase.message}
        </p>
        <div className={styles.editorActions}>
          <button type="button" className={styles.editorButton} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }

  const { file } = phase;
  const dirty = draft !== file.text;

  const save = (): void => {
    setFailure(null);
    setSaved(false);
    // The bytes are built here, once, and handed down unchanged: the file gets
    // exactly what this line produces.
    const contents = fromEditor(draft, file.shape);
    void saveEditedFile(store, file, contents)
      .then((next) => {
        setPhase({ state: 'ready', file: next });
        setDraft(next.text);
        setSaved(true);
      })
      .catch((error: unknown) => {
        setFailure(explain(error));
      });
  };

  const close = (): void => {
    if (dirty && !confirmingClose) {
      setConfirmingClose(true);
      return;
    }
    onClose();
  };

  return (
    <div className={styles.editor}>
      <textarea
        ref={area}
        className={styles.editorText}
        aria-label={`Contents of ${path}`}
        spellCheck={false}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setSaved(false);
          setConfirmingClose(false);
        }}
      />

      <div className={styles.editorActions}>
        <button
          type="button"
          className={`${styles.editorButton} ${styles.editorPrimary}`}
          disabled={busy || !dirty}
          onClick={save}
        >
          Save
        </button>
        <button type="button" className={styles.editorButton} onClick={close}>
          {confirmingClose ? 'Discard changes and close' : 'Close'}
        </button>

        {confirmingClose && (
          <span className={styles.editorWarning} role="alert">
            This file has unsaved changes. Closing loses them.
          </span>
        )}
        {!confirmingClose && dirty && (
          <span className={styles.editorNote}>Unsaved changes.</span>
        )}
        {!dirty && saved && (
          <span className={styles.editorNote} role="status">
            Saved to disk. The diff below was re-read.
          </span>
        )}
        {!dirty && !saved && (
          <span className={styles.editorNote}>
            {file.shape.eol === 'crlf' ? 'CRLF endings' : 'LF endings'}
            {file.shape.bom ? ' · byte-order mark' : ''}
            {file.shape.finalNewline ? '' : ' · no trailing newline'} — kept as they are
            on save.
          </span>
        )}
      </div>

      {failure !== null && (
        <p className={styles.editorFailure} role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}
