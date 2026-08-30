/**
 * The way out of a stopped rebase, cherry-pick, revert or merge.
 *
 * It sits with the commit box because that is where the user already is when an
 * operation stops: they staged the resolution, and the next thing they need is
 * "continue" — not a button somewhere else on screen. During a rebase the
 * commit box itself is useless (git makes the commit when the rebase resumes),
 * so this panel takes its place rather than sitting beside it.
 *
 * Every label names the operation git is actually in. That is the entire point:
 * the app used to say "merge" for everything and run `git merge --abort`, which
 * during a rebase fails with "MERGE_HEAD missing" and leaves the user stopped,
 * detached, with nothing on screen that can move them.
 */

import { useState, type ReactNode } from 'react';
import { isContinuable, type Operation, type OperationKind } from '../../git/operation';
import {
  abortStoppedOperation,
  continueStoppedOperation,
  skipStoppedCommit,
} from '../../state/actions';
import { useAppState, useStore } from '../../state/hooks';
import { isBusy } from '../../state/store';
import styles from './OperationPanel.module.css';

/** What each operation is called in a sentence. */
const NOUN: Record<OperationKind, string> = {
  rebase: 'rebase',
  'cherry-pick': 'cherry-pick',
  revert: 'revert',
  merge: 'merge',
};

/** What each operation is called on a button. */
const VERB: Record<OperationKind, string> = {
  rebase: 'Rebase',
  'cherry-pick': 'Cherry-pick',
  revert: 'Revert',
  merge: 'Merge',
};

/**
 * The headline: where the replay is, in git's own counting.
 *
 * "Commit 3 of 43" is the fact that turns a stopped rebase from a mystery into
 * a task with a length. Git records it, and until now the app never read it.
 */
export function progressLine(operation: Operation): string {
  const noun = operation.kind === null ? 'operation' : NOUN[operation.kind];
  if (operation.kind !== 'rebase') {
    return `A ${noun} is in progress.`;
  }
  const where =
    operation.step !== null && operation.steps !== null
      ? `commit ${String(operation.step)} of ${String(operation.steps)}`
      : 'a commit';
  const branch = operation.branch === null ? '' : ` of ${operation.branch}`;
  return `Rebasing ${where}${branch}.`;
}

/** The sentence the user agrees to before abandoning the operation. */
export function abortQuestion(kind: OperationKind): string {
  return `Abort the ${NOUN[kind]} and put the repository back where it was before it started? Every conflict you have resolved since then is discarded.`;
}

/** The sentence the user agrees to before dropping the stopped commit. */
export function skipQuestion(kind: OperationKind): string {
  return `Skip this commit and carry on with the ${NOUN[kind]}? Its changes are left out of the result — the commit itself stays in the reflog.`;
}

/** The sentence behind Continue: it commits the staged resolution. */
export function continueQuestion(kind: OperationKind): string {
  return `Continue the ${NOUN[kind]} with what is staged now as the resolution.`;
}

export function OperationPanel(): ReactNode {
  const store = useStore();
  const operation = useAppState((state) => state.operation);
  const status = useAppState((state) => state.status);
  const busy = useAppState(isBusy);
  const [asking, setAsking] = useState<'abort' | 'skip' | null>(null);

  const kind = operation.kind;
  if (kind === null) return null;

  // Git refuses to continue while anything is unmerged, and says so clearly.
  // Saying it first turns a failed command into a disabled button with a reason.
  const unmerged =
    status.state === 'ready'
      ? status.value.entries.filter((entry) => entry.conflicted).length
      : 0;
  const blocked =
    unmerged > 0
      ? unmerged === 1
        ? '1 file is still conflicted. Resolve it and stage it first.'
        : `${String(unmerged)} files are still conflicted. Resolve them and stage them first.`
      : null;

  const run = (what: 'continue' | 'skip' | 'abort'): void => {
    setAsking(null);
    if (what === 'abort') {
      void abortStoppedOperation(store, kind, abortQuestion(kind));
      return;
    }
    if (!isContinuable(kind)) return;
    if (what === 'skip') {
      void skipStoppedCommit(store, kind, skipQuestion(kind));
      return;
    }
    void continueStoppedOperation(store, kind, continueQuestion(kind));
  };

  return (
    <section className={styles.panel} aria-label={`${VERB[kind]} in progress`}>
      <p className={styles.progress}>{progressLine(operation)}</p>
      {operation.commit !== null && operation.commit.subject.length > 0 && (
        <p className={styles.subject} title={operation.commit.oid}>
          {operation.commit.subject}
        </p>
      )}

      {!isContinuable(kind) && (
        <p className={styles.hint}>
          Resolve the conflicts, stage them, and commit to finish the merge — or abort it.
        </p>
      )}

      {asking === null ? (
        <div className={styles.actions}>
          {isContinuable(kind) && (
            <button
              type="button"
              className={styles.primary}
              disabled={busy || blocked !== null}
              title={blocked ?? continueQuestion(kind)}
              onClick={() => run('continue')}
            >
              Continue {NOUN[kind]}
            </button>
          )}
          {isContinuable(kind) && (
            <button
              type="button"
              className={styles.secondary}
              disabled={busy}
              title={`Leave this commit out of the ${NOUN[kind]}`}
              onClick={() => setAsking('skip')}
            >
              Skip commit…
            </button>
          )}
          <button
            type="button"
            className={styles.danger}
            disabled={busy}
            onClick={() => setAsking('abort')}
          >
            Abort {NOUN[kind]}…
          </button>
        </div>
      ) : (
        <div className={styles.question} role="alertdialog" aria-label="Are you sure?">
          <p className={styles.questionText}>
            {asking === 'abort' ? abortQuestion(kind) : skipQuestion(kind)}
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => setAsking(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className={styles.danger}
              disabled={busy}
              onClick={() => run(asking)}
            >
              {asking === 'abort' ? `Abort ${NOUN[kind]}` : 'Skip this commit'}
            </button>
          </div>
        </div>
      )}

      {blocked !== null && <p className={styles.blocked}>{blocked}</p>}
    </section>
  );
}
