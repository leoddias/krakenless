/**
 * The commit context menu, and the questions its items ask.
 *
 * This component outlives the menu on purpose. Choosing "Reset main to this
 * commit — hard" closes the menu and opens a question; if the menu owned the
 * question, dismissing one would dismiss the other. So the host stays mounted
 * from the right-click until either the menu is dismissed with nothing chosen
 * or a question has been answered.
 *
 * Every destructive item is two steps and never one, the same rule the refs
 * panel follows: the string the user reads in the question is the string handed
 * to the action layer as the confirmation reason, so the token the git layer
 * validates is literally what they agreed to. And the branch named in that
 * string is re-checked against HEAD inside the git layer before anything runs
 * (see `src/git/commits.ts`) — the question and the command are separated by a
 * dialog, and HEAD can move in between.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Commit, StashEntry } from '../../git/types';
import {
  checkoutCommit,
  cherryPickCommit,
  createBranchAt,
  createTagAt,
  rebaseBranchOnto,
  removeStash,
  resetBranchTo,
  restoreStash,
  revertCommitOnHead,
} from '../../state/actions';
import { useAppState, useStore } from '../../state/hooks';
import { isBusy } from '../../state/store';
import { ContextMenu, type MenuSection } from '../shell/ContextMenu';
import { copyText } from '../shell/clipboard';
import { BRANCH_NOUN, TAG_NOUN, refNameError, type RefNoun } from '../shell/refName';
import { trapTab } from '../shell/trapTab';
import {
  applyStashQuestion,
  dropRecoveryCommand,
  dropStashQuestion,
  popStashQuestion,
} from '../refs/labels';
import {
  buildCommitMenu,
  buildStashMenu,
  commitLabel,
  rebaseQuestion,
  resetQuestion,
  type CommitAction,
  type CommitMenuItem,
} from './commitMenu';
import styles from './CommitActions.module.css';

/** Where the menu was opened, and on what. */
export interface CommitMenuTarget {
  commit: Commit;
  /**
   * Set when the row is a stash rather than a commit. It comes from the stash
   * list, not from the commit, and it carries the oid the row was drawn from —
   * which is what lets the git layer refuse a `stash@{n}` that has shifted
   * since (any stash push renumbers them, including this app's own discard).
   */
  stash?: StashEntry;
  /** Viewport coordinates of the right-click. */
  x: number;
  y: number;
}

/** A question that needs a name (and sometimes a message) before it can run. */
interface NameDialog {
  kind: 'name';
  title: string;
  /** Which ref rules the field is checked against. */
  noun: RefNoun;
  /** Present for an annotated tag, which git will not create without one. */
  needsMessage: boolean;
  /** Present for a branch, which may or may not be switched to. */
  offersCheckout: boolean;
  run: (values: { name: string; message: string; checkout: boolean }) => Promise<unknown>;
}

/** A question that only needs a yes. */
interface ConfirmDialog {
  kind: 'confirm';
  title: string;
  /** The consequence, in the words that become the confirmation reason. */
  question: string;
  confirmLabel: string;
  danger: boolean;
  run: (reason: string) => Promise<unknown>;
}

type Dialog = NameDialog | ConfirmDialog;

export function CommitActions({
  target,
  onDismiss,
}: {
  target: CommitMenuTarget;
  onDismiss: () => void;
}): ReactNode {
  const store = useStore();
  const busy = useAppState(isBusy);
  const status = useAppState((state) => state.status);
  const remotes = useAppState((state) => state.remotes);
  const [menuOpen, setMenuOpen] = useState(true);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const commit = target.commit;
  // Three answers, not two: a name, `null` for a detached HEAD, `undefined`
  // while the status is unread. The menu says something different for each.
  const branch =
    status.state === 'ready'
      ? status.value.detached
        ? null
        : (status.value.branch ?? undefined)
      : undefined;

  const notify = (tone: 'info' | 'warning', message: string): void => {
    store.dispatch({ type: 'notice', notice: { tone, message } });
  };

  const copy = (text: string, what: string): void => {
    void copyText(text).then((copied) => {
      notify(
        copied ? 'info' : 'warning',
        copied
          ? `${what} was copied to the clipboard.`
          : `${what} could not be copied — this window has no clipboard access.`,
      );
    });
  };

  const perform = (action: CommitAction): void => {
    switch (action.kind) {
      case 'copy':
        copy(action.text, action.what);
        return;
      case 'checkout':
        void checkoutCommit(store, commit.oid);
        return;
      case 'cherry-pick':
        void cherryPickCommit(store, commit.oid);
        return;
      case 'revert':
        void revertCommitOnHead(store, commit.oid);
        return;
      case 'branch':
        setDialog({
          kind: 'name',
          title: `Create a branch at ${commitLabel(commit)}`,
          noun: BRANCH_NOUN,
          needsMessage: false,
          offersCheckout: true,
          run: ({ name, checkout }) =>
            createBranchAt(store, name, commit.oid, { checkout }),
        });
        return;
      case 'tag':
        setDialog({
          kind: 'name',
          title: `${action.annotated ? 'Create an annotated tag' : 'Create a tag'} at ${commitLabel(commit)}`,
          noun: TAG_NOUN,
          needsMessage: action.annotated,
          offersCheckout: false,
          run: ({ name, message }) =>
            createTagAt(store, name, commit.oid, action.annotated ? { message } : {}),
        });
        return;
      case 'rebase':
        setDialog({
          kind: 'confirm',
          title: `Rebase ${action.branch} onto this commit?`,
          question: rebaseQuestion(action.branch, commit),
          confirmLabel: 'Rebase',
          danger: true,
          run: (reason) => rebaseBranchOnto(store, action.branch, commit.oid, reason),
        });
        return;
      case 'reset':
        setDialog({
          kind: 'confirm',
          title: `Reset ${action.branch} to this commit?`,
          question: resetQuestion(action.branch, action.mode, commit),
          confirmLabel: `Reset (${action.mode})`,
          // Only the hard reset takes uncommitted work off disk; the other two
          // move a branch, which the reflog can undo.
          danger: action.mode === 'hard',
          run: (reason) =>
            resetBranchTo(store, action.branch, commit.oid, action.mode, reason),
        });
        return;
      case 'stash':
        setDialog(stashDialog(action.entry, action.op));
        return;
    }
  };

  /**
   * The question a stash action asks, and what it runs.
   *
   * The question strings are the refs panel's own — the same words, so the two
   * places that can pop a stash cannot drift into describing it differently,
   * and so the confirmation reason the git layer records is the same either
   * way.
   */
  function stashDialog(entry: StashEntry, op: 'apply' | 'pop' | 'drop'): ConfirmDialog {
    if (op === 'drop') {
      const question = dropStashQuestion(entry);
      return {
        kind: 'confirm',
        title: 'Delete this stash?',
        question,
        confirmLabel: 'Delete Stash',
        danger: true,
        run: async () => {
          const dropped = await removeStash(store, entry, question);
          // `stash drop` only deletes the ref; the commit survives until git
          // collects it, and the oid is the only way to name it afterwards.
          // Saying so is the whole reason this is allowed to be one click.
          const recovery = dropRecoveryCommand(entry.oid);
          if (dropped && recovery !== null) {
            store.dispatch({
              type: 'notice',
              notice: {
                tone: 'info',
                message: `Dropped ${entry.ref}.`,
                undoHint: recovery,
              },
            });
          }
          return dropped;
        },
      };
    }

    const pop = op === 'pop';
    const question = pop ? popStashQuestion(entry) : applyStashQuestion(entry);
    return {
      kind: 'confirm',
      title: pop ? 'Pop this stash?' : 'Apply this stash?',
      question,
      confirmLabel: pop ? 'Pop Stash' : 'Apply Stash',
      // Applying writes over the working tree, but only where the stash
      // touched it, and git refuses outright rather than clobbering an edit.
      danger: false,
      run: (reason) => restoreStash(store, entry, { pop }, reason),
    };
  }

  const stash = target.stash;
  const sections: MenuSection[] = (
    stash === undefined
      ? buildCommitMenu({
          commit,
          branch,
          busy,
          hasConflicts: status.state === 'ready' && status.value.hasConflicts,
          remotes,
        })
      : buildStashMenu(stash, {
          busy,
          hasConflicts: status.state === 'ready' && status.value.hasConflicts,
        })
  ).map((section) => section.map(toMenuItem));

  function toMenuItem(item: CommitMenuItem): MenuSection[number] {
    const action = item.action;
    return {
      id: item.id,
      label: item.label,
      disabled: item.disabled,
      ...(action === undefined ? {} : { onSelect: () => perform(action) }),
      ...(item.submenu === undefined ? {} : { submenu: item.submenu.map(toMenuItem) }),
    };
  }

  return (
    <>
      {menuOpen && (
        <ContextMenu
          sections={sections}
          x={target.x}
          y={target.y}
          label={
            stash === undefined
              ? `Actions for commit ${commit.shortOid}`
              : `Actions for stash ${stash.ref}`
          }
          onClose={() => {
            setMenuOpen(false);
            // A menu closed without choosing anything is the end of the
            // interaction; one closed *by* a choice has a dialog behind it,
            // and `perform` has already set it by the time this runs.
            setDialog((current) => {
              if (current === null) onDismiss();
              return current;
            });
          }}
        />
      )}
      {dialog !== null && <DialogHost dialog={dialog} onClose={onDismiss} busy={busy} />}
    </>
  );
}

function DialogHost({
  dialog,
  onClose,
  busy,
}: {
  dialog: Dialog;
  onClose: () => void;
  busy: boolean;
}): ReactNode {
  /**
   * True from the moment the answer is given until the command has resolved.
   *
   * `state.busy` alone is not enough: the action layer clears it *before*
   * awaiting the refreshes that follow, so a second click in that window would
   * run the command twice against one answer. The refs panel guards the same
   * gap the same way.
   */
  const [running, setRunning] = useState(false);
  const locked = busy || running;

  const finish = (result: Promise<unknown>): void => {
    setRunning(true);
    void result.finally(() => {
      setRunning(false);
      // Whether it worked or not, the question has been answered. Failures
      // arrive in the notice bar, which outlives this dialog.
      onClose();
    });
  };

  return (
    <div className={styles.backdrop} role="presentation">
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={dialog.title}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !locked) {
            event.stopPropagation();
            onClose();
            return;
          }
          trapTab(event);
        }}
      >
        <h2 className={styles.title}>{dialog.title}</h2>
        {dialog.kind === 'confirm' ? (
          <ConfirmBody dialog={dialog} locked={locked} onClose={onClose} onRun={finish} />
        ) : (
          <NameBody dialog={dialog} locked={locked} onClose={onClose} onRun={finish} />
        )}
      </div>
    </div>
  );
}

function ConfirmBody({
  dialog,
  locked,
  onClose,
  onRun,
}: {
  dialog: ConfirmDialog;
  locked: boolean;
  onClose: () => void;
  onRun: (result: Promise<unknown>) => void;
}): ReactNode {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Focus lands on Cancel, never on the button that does the thing: a stray
  // Enter after a right-click must not run a rebase.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <>
      <p className={dialog.danger ? styles.questionDanger : styles.question}>
        {dialog.question}
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.secondary}
          ref={cancelRef}
          disabled={locked}
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className={dialog.danger ? styles.danger : styles.primary}
          ref={confirmRef}
          disabled={locked}
          // The question is the reason: what the user read is what the git
          // layer receives as the token's justification.
          onClick={() => onRun(dialog.run(dialog.question))}
        >
          {dialog.confirmLabel}
        </button>
      </div>
    </>
  );
}

function NameBody({
  dialog,
  locked,
  onClose,
  onRun,
}: {
  dialog: NameDialog;
  locked: boolean;
  onClose: () => void;
  onRun: (result: Promise<unknown>) => void;
}): ReactNode {
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [checkout, setCheckout] = useState(true);
  const [touched, setTouched] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const nameError = refNameError(name, dialog.noun);
  const messageError =
    dialog.needsMessage && message.trim().length === 0
      ? 'An annotated tag needs a message — git has nothing to store without one.'
      : null;
  const error = nameError ?? messageError;

  const submit = (): void => {
    setTouched(true);
    if (error !== null || locked) return;
    onRun(dialog.run({ name, message, checkout }));
  };

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Name</span>
        <input
          className={styles.input}
          ref={nameRef}
          value={name}
          disabled={locked}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={touched && nameError !== null ? true : undefined}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => setTouched(true)}
        />
      </label>

      {dialog.needsMessage && (
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Message</span>
          <textarea
            className={styles.textarea}
            value={message}
            disabled={locked}
            rows={3}
            onChange={(event) => setMessage(event.target.value)}
          />
        </label>
      )}

      {dialog.offersCheckout && (
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={checkout}
            disabled={locked}
            onChange={(event) => setCheckout(event.target.checked)}
          />
          <span>Switch to the new branch</span>
        </label>
      )}

      {touched && error !== null && (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      )}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.secondary}
          disabled={locked}
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="submit"
          className={styles.primary}
          // Disabled only once the user has been told why, so an untouched
          // form does not present a dead button with no explanation.
          disabled={locked || (touched && error !== null)}
        >
          Create
        </button>
      </div>
    </form>
  );
}
