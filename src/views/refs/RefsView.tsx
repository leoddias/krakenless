/**
 * Refs panel: local and remote branches, and the stash list.
 *
 * Three rules shape this file, all of them about not destroying work by
 * accident. Deleting a branch is two steps and never one: the panel asks with
 * the safe `-d`, and only if git reports the branch is unmerged does it ask a
 * *second* question that names the consequence — force is never the first
 * attempt and never an automatic escalation, because the whole value of the
 * refusal is that the user reads it. Every stash action carries the oid the row
 * was rendered from, so an entry that shifted underneath the list (any stash
 * push renumbers `stash@{n}`, including this app's own discard) is refused by
 * the git layer instead of the wrong stash being popped; a refusal is reported
 * as "the list moved, look again", never retried. And the confirmation string
 * shown to the user is the same string handed to the action layer, so the token
 * the git layer validates is literally what they agreed to.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { Branch, StashEntry } from '../../git/types';
import {
  createAndSwitch,
  refreshBranches,
  refreshStashes,
  removeBranch,
  removeStash,
  restoreStash,
  switchTo,
} from '../../state/actions';
import { useAppState, useStore } from '../../state/hooks';
import styles from './RefsView.module.css';
import {
  applyStashQuestion,
  branchNameError,
  deleteBranchQuestion,
  dropRecoveryCommand,
  dropStashQuestion,
  forceDeleteBranchQuestion,
  formatRelativeDate,
  groupBranches,
  localNameFor,
  popStashQuestion,
  stashLabel,
  trackingSummary,
} from './labels';

/**
 * The delete question currently on screen.
 *
 * `safe` is the only stage a click can create. `force` exists solely as the
 * result of git having refused, and carries the warning git produced so the
 * second question is asked with the real consequence in view.
 */
type Deletion = {
  name: string;
  /**
   * Repository the question was asked about. Branch names collide across
   * repositories (`main` is everywhere), and the action layer resolves the root
   * from *current* state — so a question answered after the user switched
   * repositories would delete a same-named branch somewhere else.
   */
  root: string;
} & ({ stage: 'safe' } | { stage: 'force'; warning: string });

type StashActionKind = 'apply' | 'pop' | 'drop';

interface StashQuestion {
  entry: StashEntry;
  kind: StashActionKind;
  root: string;
}

/** A stash that was dropped, and the oid that is the only way back to it. */
interface DropRecovery {
  label: string;
  oid: string;
  /** Repository the oid lives in; it names nothing in any other one. */
  root: string;
}

/**
 * Something that did not happen, or did not happen the way the button said.
 *
 * `cause` is git's own words, taken from the notice the action layer produced,
 * because the boolean the action returns cannot tell a refused stash from a
 * stash that applied *with conflicts* — and those two need opposite reactions
 * from the user.
 */
interface Failure {
  text: string;
  cause: string | null;
  /** Repository it is about; it is not shown against any other one. */
  root: string;
}

/** A message about something that did happen, in the repository named here. */
interface Outcome {
  text: string;
  root: string;
}

export function RefsView(): ReactNode {
  const store = useStore();
  const busy = useAppState((state) => state.busy);
  const selectedOid = useAppState((state) => state.selection.commitOid);
  const root = useAppState((state) =>
    state.repo.state === 'ready' ? state.repo.value.root : null,
  );

  const [deletion, setDeletion] = useState<Deletion | null>(null);
  const [stashQuestion, setStashQuestion] = useState<StashQuestion | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [recovery, setRecovery] = useState<DropRecovery | null>(null);
  /**
   * True from the moment a confirmed operation starts until it has resolved.
   *
   * `state.busy` is not enough: the action layer clears it *before* awaiting the
   * refreshes that follow, so between those two moments the buttons are live
   * again while the answer to the previous question is still on its way. A
   * second click in that window would run a second git command against a
   * question the user answered once.
   */
  const [running, setRunning] = useState(false);
  const locked = busy || running;

  // Both lists are loaded for whatever repository is open, and re-loaded when
  // the user opens another one — a stale branch list belongs to a different
  // repository and every button on it would act on the wrong refs.
  useEffect(() => {
    if (root === null) return;
    void refreshBranches(store);
    void refreshStashes(store);
  }, [store, root]);

  // Anything asked or said about another repository is not shown against this
  // one. Derived rather than cleared on a repo change, so there is no render in
  // which a question about repository A is on screen over repository B: branch
  // names collide across repositories, and the action layer resolves the root
  // from current state. `recovery` is exempt on purpose — it names its own
  // repository and is the only route back to work that was dropped.
  const openDeletion = deletion !== null && deletion.root === root ? deletion : null;
  const openStashQuestion =
    stashQuestion !== null && stashQuestion.root === root ? stashQuestion : null;
  const shownFailure = failure !== null && failure.root === root ? failure : null;
  const shownOutcome = outcome !== null && outcome.root === root ? outcome : null;

  const clearMessages = (): void => {
    setFailure(null);
    setOutcome(null);
    // `recovery` is deliberately not cleared here: it holds the only route back
    // to work that was just dropped, and the next click must not take it away.
  };

  /**
   * Runs a confirmed operation, reporting what git said when it did not do what
   * the button promised.
   *
   * The action layer swallows the error into a store notice and returns only a
   * boolean, so the notice is read back here — comparing identity, so a stale
   * message from an earlier operation is never presented as this one's cause.
   */
  const perform = async <T,>(run: () => Promise<T>): Promise<[T, string | null]> => {
    const before = store.getState().notice;
    setRunning(true);
    try {
      const result = await run();
      const after = store.getState().notice;
      const cause =
        after !== null && after !== before && after.tone === 'error'
          ? after.message
          : null;
      return [result, cause];
    } finally {
      setRunning(false);
    }
  };

  /** True while the question still applies to the repository that is open. */
  const stillCurrent = (askedAbout: string): boolean => {
    const repo = store.getState().repo;
    return repo.state === 'ready' && repo.value.root === askedAbout;
  };

  const runDelete = async (pending: Deletion): Promise<void> => {
    if (running) return;
    clearMessages();
    const { name } = pending;
    if (!stillCurrent(pending.root)) {
      setDeletion(null);
      setFailure({
        text: `Nothing was deleted: the open repository changed after the question about "${name}" was asked.`,
        cause: null,
        root: pending.root,
      });
      return;
    }

    const force = pending.stage === 'force';
    const reason = force ? forceDeleteBranchQuestion(name) : deleteBranchQuestion(name);

    const [result, cause] = await perform(() =>
      removeBranch(store, name, reason, { force }),
    );
    if (result !== null && result.deleted) {
      setDeletion(null);
      setOutcome({ text: `Deleted branch "${name}".`, root: pending.root });
      return;
    }
    if (result !== null && result.unmergedWarning !== undefined) {
      // Ask again — a different question, with the warning attached. Nothing
      // here calls the action layer a second time on its own, and the forcing
      // button arrives disarmed (see DeleteConfirmation).
      setDeletion({ ...pending, stage: 'force', warning: result.unmergedWarning });
      return;
    }
    setDeletion(null);
    setFailure({ text: `Branch "${name}" was not deleted.`, cause, root: pending.root });
  };

  const runStashAction = async (pending: StashQuestion): Promise<void> => {
    if (running) return;
    clearMessages();
    setStashQuestion(null);
    const { entry, kind } = pending;
    if (!stillCurrent(pending.root)) {
      setFailure({
        text: `Nothing was done: the open repository changed after the question about "${stashLabel(entry)}" was asked.`,
        cause: null,
        root: pending.root,
      });
      return;
    }
    // The oid travels with the ref: `stash@{1}` alone is a position, and
    // positions move.
    const target = { ref: entry.ref, oid: entry.oid };

    const [done, cause] = await perform(() =>
      kind === 'drop'
        ? removeStash(store, target, dropStashQuestion(entry))
        : restoreStash(
            store,
            target,
            { pop: kind === 'pop' },
            kind === 'pop' ? popStashQuestion(entry) : applyStashQuestion(entry),
          ),
    );

    if (!done) {
      // Deliberately not "nothing happened": a pop or apply that *conflicts*
      // also fails, and it has already written the working tree. Git's own
      // message is the only thing that can tell those apart, so it leads.
      setFailure({
        text:
          kind === 'drop'
            ? `Dropping stash "${stashLabel(entry)}" did not complete. If git refused because the list moved, the entry is untouched — the list has been re-read, so act on the row you see now.`
            : `${ACTION_NOUN[kind]} "${stashLabel(entry)}" did not complete. Read what git reported before retrying: a stash that applied with conflicts also fails, and your working tree already contains the changes and the conflict markers. If instead git refused because the list moved, nothing was touched.`,
        cause,
        root: pending.root,
      });
      return;
    }
    if (kind === 'drop') {
      setRecovery({ label: stashLabel(entry), oid: entry.oid, root: pending.root });
      return;
    }
    setOutcome({
      text:
        kind === 'pop'
          ? `Popped stash "${stashLabel(entry)}" — it is no longer in the list.`
          : `Applied stash "${stashLabel(entry)}" — it is still in the list.`,
      root: pending.root,
    });
  };

  // Computed once: a recovery command is only offered when the oid git handed
  // back is one this panel can vouch for.
  const recoveryCommand = recovery === null ? null : dropRecoveryCommand(recovery.oid);

  return (
    <section className={styles.panel} aria-label="Branches and stashes">
      {/*
        The open question comes first, so a notice appearing or being dismissed
        underneath it cannot shift a destructive button under the pointer. Only
        one question is ever on screen.
      */}
      {openDeletion !== null && (
        <DeleteConfirmation
          // Keyed by stage: the forcing question is a fresh component, so it
          // cannot inherit the armed state of the one it replaced.
          key={openDeletion.stage}
          deletion={openDeletion}
          busy={locked}
          onCancel={() => setDeletion(null)}
          onConfirm={() => void runDelete(openDeletion)}
        />
      )}

      {openStashQuestion !== null && (
        <StashConfirmation
          question={openStashQuestion}
          busy={locked}
          onCancel={() => setStashQuestion(null)}
          onConfirm={() => void runStashAction(openStashQuestion)}
        />
      )}

      {/*
        A drop leaves an oid that is the only route back to the work, so this
        notice outlives the lists reloading underneath it and every later click.
      */}
      {recovery !== null && (
        <div className={styles.recovery} role="status">
          <strong className={styles.noticeTitle}>
            Dropped stash &quot;{recovery.label}&quot;
          </strong>
          <p className={styles.noticeText}>
            The entry is gone from the list, but its commit survives in {recovery.root}{' '}
            until git collects it.{' '}
            {recoveryCommand === null
              ? 'Git reported an object id this panel does not recognise, so no command is offered here — look for the entry with `git fsck --unreachable`.'
              : 'Run this there to bring the changes back:'}
          </p>
          {recoveryCommand !== null && (
            <pre className={styles.noticeCommand}>
              <code>{recoveryCommand}</code>
            </pre>
          )}
          <button
            type="button"
            className={styles.button}
            onClick={() => setRecovery(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {shownFailure !== null && (
        <div className={styles.failure} role="alert">
          <p className={styles.noticeText}>{shownFailure.text}</p>
          {shownFailure.cause !== null && (
            <p className={styles.noticeCause}>
              <strong>git said:</strong> {shownFailure.cause}
            </p>
          )}
          <button
            type="button"
            className={styles.button}
            onClick={() => setFailure(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {shownOutcome !== null && (
        <div className={styles.outcome} role="status">
          <p className={styles.noticeText}>{shownOutcome.text}</p>
          <button
            type="button"
            className={styles.button}
            onClick={() => setOutcome(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className={styles.body}>
        <BranchesSection
          busy={locked}
          selectedOid={selectedOid}
          onSwitch={(name) => {
            clearMessages();
            void switchTo(store, name);
          }}
          onCreate={async (name, startPoint) => {
            clearMessages();
            return createAndSwitch(store, name, startPoint);
          }}
          onAskDelete={(name) => {
            if (root === null) return;
            clearMessages();
            setStashQuestion(null);
            // Always the safe stage: force is unreachable from a click.
            setDeletion({ stage: 'safe', name, root });
          }}
        />

        <StashesSection
          busy={locked}
          onAsk={(entry, kind) => {
            if (root === null) return;
            clearMessages();
            setDeletion(null);
            setStashQuestion({ entry, kind, root });
          }}
        />
      </div>
    </section>
  );
}

const ACTION_NOUN: Record<StashActionKind, string> = {
  apply: 'Applying stash',
  pop: 'Popping stash',
  drop: 'Dropping stash',
};

// --- branches ---------------------------------------------------------------

function BranchesSection({
  busy,
  selectedOid,
  onSwitch,
  onCreate,
  onAskDelete,
}: {
  busy: boolean;
  selectedOid: string | null;
  onSwitch: (name: string) => void;
  onCreate: (name: string, startPoint?: string) => Promise<boolean>;
  onAskDelete: (name: string) => void;
}): ReactNode {
  const branches = useAppState((state) => state.branches);

  return (
    <section className={styles.section} aria-label="Branches">
      <header className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Branches</h2>
      </header>

      <CreateBranchForm busy={busy} selectedOid={selectedOid} onCreate={onCreate} />

      {branches.state === 'idle' && (
        <Notice title="No repository open">Open a repository to see its branches.</Notice>
      )}
      {branches.state === 'loading' && (
        <Notice title="Loading branches…" live>
          Reading refs from git.
        </Notice>
      )}
      {branches.state === 'error' && (
        <Notice title="Could not read the branches" tone="error">
          {branches.message}
          {branches.kind !== undefined ? ` (${branches.kind})` : ''}
        </Notice>
      )}
      {branches.state === 'ready' && (
        <BranchLists
          branches={branches.value}
          busy={busy}
          onSwitch={onSwitch}
          onCreate={onCreate}
          onAskDelete={onAskDelete}
        />
      )}
    </section>
  );
}

function BranchLists({
  branches,
  busy,
  onSwitch,
  onCreate,
  onAskDelete,
}: {
  branches: readonly Branch[];
  busy: boolean;
  onSwitch: (name: string) => void;
  onCreate: (name: string, startPoint?: string) => Promise<boolean>;
  onAskDelete: (name: string) => void;
}): ReactNode {
  const { local, remote } = groupBranches(branches);

  return (
    <>
      <section className={styles.subsection} aria-label="Local branches">
        <h3 className={styles.subsectionTitle}>Local</h3>
        {local.length === 0 ? (
          <p className={styles.empty}>No local branches yet.</p>
        ) : (
          <ul className={styles.list}>
            {local.map((branch) => (
              <li key={branch.name} className={styles.row}>
                <BranchButton branch={branch} busy={busy} onSwitch={onSwitch} />
                <Divergence branch={branch} />
                <button
                  type="button"
                  className={`${styles.button} ${styles.danger}`}
                  disabled={busy || branch.current}
                  title={
                    branch.current
                      ? 'The checked-out branch cannot be deleted. Switch away first.'
                      : `Delete ${branch.name}`
                  }
                  onClick={() => onAskDelete(branch.name)}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.subsection} aria-label="Remote branches">
        <h3 className={styles.subsectionTitle}>Remote</h3>
        {remote.length === 0 ? (
          <p className={styles.empty}>No remote-tracking branches.</p>
        ) : (
          <ul className={styles.list}>
            {remote.map((branch) => (
              <RemoteRow
                key={branch.name}
                branch={branch}
                busy={busy}
                onCreate={onCreate}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function BranchButton({
  branch,
  busy,
  onSwitch,
}: {
  branch: Branch;
  busy: boolean;
  onSwitch: (name: string) => void;
}): ReactNode {
  // The current branch is `aria-disabled`, not `disabled`: the row stays
  // focusable so a keyboard user can read where they are, and its click is
  // simply not a switch.
  return (
    <button
      type="button"
      className={`${styles.name} ${branch.current ? styles.current : ''}`}
      disabled={busy}
      aria-disabled={branch.current ? 'true' : undefined}
      aria-current={branch.current ? 'true' : undefined}
      title={
        branch.current
          ? `${branch.name} is the current branch. ${trackingSummary(branch)}`
          : `Switch to ${branch.name}. ${trackingSummary(branch)}`
      }
      onClick={() => {
        if (!branch.current) onSwitch(branch.name);
      }}
    >
      <span aria-hidden="true" className={styles.marker}>
        {branch.current ? '●' : '○'}
      </span>
      {branch.name}
      {branch.current && <span className={styles.srOnly}> (current branch)</span>}
    </button>
  );
}

/**
 * A remote-tracking row. It offers to *create* the local branch rather than
 * switch: `git switch origin/main` is not a checkout of that branch, and the
 * created form is the one that records the upstream.
 */
function RemoteRow({
  branch,
  busy,
  onCreate,
}: {
  branch: Branch;
  busy: boolean;
  onCreate: (name: string, startPoint?: string) => Promise<boolean>;
}): ReactNode {
  const local = localNameFor(branch);

  return (
    <li className={styles.row}>
      <span className={styles.name} title={trackingSummary(branch)}>
        <span aria-hidden="true" className={styles.marker}>
          ○
        </span>
        {branch.name}
      </span>
      <Divergence branch={branch} />
      {local === null ? (
        <span className={styles.hint}>No local name can be derived</span>
      ) : (
        <button
          type="button"
          className={styles.button}
          disabled={busy}
          title={`Create local branch ${local} from ${branch.name} and switch to it`}
          onClick={() => void onCreate(local, branch.name)}
        >
          Check out as {local}
        </button>
      )}
    </li>
  );
}

function Divergence({ branch }: { branch: Branch }): ReactNode {
  return (
    <span className={styles.divergence} title={trackingSummary(branch)}>
      {branch.ahead > 0 && (
        <span className={styles.ahead}>
          ↑{branch.ahead}
          <span className={styles.srOnly}> commits ahead</span>
        </span>
      )}
      {branch.behind > 0 && (
        <span className={styles.behind}>
          ↓{branch.behind}
          <span className={styles.srOnly}> commits behind</span>
        </span>
      )}
    </span>
  );
}

function CreateBranchForm({
  busy,
  selectedOid,
  onCreate,
}: {
  busy: boolean;
  selectedOid: string | null;
  onCreate: (name: string, startPoint?: string) => Promise<boolean>;
}): ReactNode {
  const [name, setName] = useState('');
  const [fromSelected, setFromSelected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const errorId = useId();

  const useSelected = fromSelected && selectedOid !== null;

  const submit = async (): Promise<void> => {
    const candidate = name.trim();
    // Checked here so an argument-shaped name (`--force`) is refused next to
    // the field. The git layer checks again and stays the authority.
    const problem = branchNameError(candidate);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setError(null);
    const created = await onCreate(
      candidate,
      useSelected && selectedOid !== null ? selectedOid : undefined,
    );
    if (!created) {
      setError(`Branch "${candidate}" was not created.`);
      return;
    }
    setName('');
    setFromSelected(false);
  };

  return (
    <form
      className={styles.create}
      aria-label="Create branch"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className={styles.createLabel} htmlFor={fieldId}>
        New branch
      </label>
      <input
        id={fieldId}
        className={styles.input}
        value={name}
        disabled={busy}
        placeholder="feature/my-change"
        aria-invalid={error !== null}
        aria-describedby={error === null ? undefined : errorId}
        onChange={(event) => {
          setName(event.target.value);
          setError(null);
        }}
      />
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={useSelected}
          disabled={busy || selectedOid === null}
          onChange={(event) => setFromSelected(event.target.checked)}
        />
        {selectedOid === null
          ? 'Start from the current branch (no commit selected)'
          : `Start from the selected commit ${selectedOid.slice(0, 7)}`}
      </label>
      <button
        type="submit"
        className={`${styles.button} ${styles.primary}`}
        disabled={busy}
      >
        Create and switch
      </button>
      {error !== null && (
        <p id={errorId} className={styles.fieldError} role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function DeleteConfirmation({
  deletion,
  busy,
  onCancel,
  onConfirm,
}: {
  deletion: Deletion;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactNode {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const armId = useId();
  /**
   * Whether the forcing button will act at all.
   *
   * The safe and the forcing question occupy the same box, so the dangerous
   * button appears where the harmless one just was. A click already on its way
   * — or a user clicking again because the first attempt seemed to do nothing —
   * would otherwise land on `-D`. The forcing stage is a keyed remount, so it
   * always starts disarmed and needs a separate, deliberate gesture that did
   * not exist a moment ago.
   */
  const [armed, setArmed] = useState(false);

  const forcing = deletion.stage === 'force';

  // The safe choice takes focus on mount — and the forcing question is a fresh
  // mount, so it takes focus again there: a keystroke aimed at the first
  // question must never land on the second, which drops commits.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const question = forcing
    ? forceDeleteBranchQuestion(deletion.name)
    : deleteBranchQuestion(deletion.name);

  return (
    <div
      className={styles.confirm}
      role="alertdialog"
      aria-modal="true"
      aria-label={forcing ? 'Confirm forced branch delete' : 'Confirm branch delete'}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <strong className={styles.noticeTitle}>{question}</strong>
      {forcing ? (
        <p className={styles.warning}>{deletion.warning}</p>
      ) : (
        <p className={styles.noticeText}>
          Commits that are merged elsewhere stay in the repository; git refuses this if
          any of them would be lost.
        </p>
      )}
      {forcing && (
        <label className={styles.checkbox} htmlFor={armId}>
          <input
            id={armId}
            type="checkbox"
            checked={armed}
            onChange={(event) => setArmed(event.target.checked)}
          />
          I understand those commits will be lost
        </label>
      )}
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
          disabled={busy || (forcing && !armed)}
          onClick={onConfirm}
        >
          {forcing ? 'Delete anyway and drop those commits' : 'Delete branch'}
        </button>
      </div>
    </div>
  );
}

// --- stashes ----------------------------------------------------------------

function StashesSection({
  busy,
  onAsk,
}: {
  busy: boolean;
  onAsk: (entry: StashEntry, kind: StashActionKind) => void;
}): ReactNode {
  const stashes = useAppState((state) => state.stashes);
  const now = new Date();

  return (
    <section className={styles.section} aria-label="Stashes">
      <header className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Stashes</h2>
      </header>

      {stashes.state === 'idle' && (
        <Notice title="No repository open">Open a repository to see its stashes.</Notice>
      )}
      {stashes.state === 'loading' && (
        <Notice title="Loading stashes…" live>
          Reading the stash list from git.
        </Notice>
      )}
      {stashes.state === 'error' && (
        <Notice title="Could not read the stashes" tone="error">
          {stashes.message}
          {stashes.kind !== undefined ? ` (${stashes.kind})` : ''}
        </Notice>
      )}
      {stashes.state === 'ready' &&
        (stashes.value.length === 0 ? (
          <p className={styles.empty}>No stashes.</p>
        ) : (
          <ul className={styles.list}>
            {stashes.value.map((entry) => (
              <li key={entry.ref} className={styles.stashRow}>
                <div className={styles.stashText}>
                  <span className={styles.stashMessage}>{stashLabel(entry)}</span>
                  <span className={styles.stashMeta}>
                    <span className={styles.stashRef}>{entry.ref}</span>
                    {entry.branch !== undefined && <span>on {entry.branch}</span>}
                    <time dateTime={entry.date} title={entry.date}>
                      {formatRelativeDate(entry.date, now)}
                    </time>
                  </span>
                </div>
                <div className={styles.rowActions}>
                  <button
                    type="button"
                    className={styles.button}
                    disabled={busy}
                    title={`Apply ${entry.ref} and keep it in the list`}
                    onClick={() => onAsk(entry, 'apply')}
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    className={styles.button}
                    disabled={busy}
                    title={`Apply ${entry.ref} and remove it from the list`}
                    onClick={() => onAsk(entry, 'pop')}
                  >
                    Pop
                  </button>
                  <button
                    type="button"
                    className={`${styles.button} ${styles.danger}`}
                    disabled={busy}
                    title={`Remove ${entry.ref} without applying it`}
                    onClick={() => onAsk(entry, 'drop')}
                  >
                    Drop
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}

function StashConfirmation({
  question,
  busy,
  onCancel,
  onConfirm,
}: {
  question: StashQuestion;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactNode {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { entry, kind } = question;

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const text =
    kind === 'apply'
      ? applyStashQuestion(entry)
      : kind === 'pop'
        ? popStashQuestion(entry)
        : dropStashQuestion(entry);

  return (
    <div
      className={styles.confirm}
      role="alertdialog"
      aria-modal="true"
      aria-label="Confirm stash action"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <strong className={styles.noticeTitle}>{text}</strong>
      <p className={kind === 'drop' ? styles.warning : styles.noticeText}>
        {kind === 'apply' &&
          'The stash stays in the list, so it can be applied again elsewhere.'}
        {kind === 'pop' &&
          'The entry leaves the list once it applies cleanly; if it conflicts, git keeps it.'}
        {kind === 'drop' &&
          'The changes are not applied anywhere. Its commit survives until git collects it, and the recovery command will be shown afterwards.'}
      </p>
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
          className={`${styles.button} ${kind === 'drop' ? styles.danger : styles.primary}`}
          disabled={busy}
          onClick={onConfirm}
        >
          {kind === 'apply' ? 'Apply stash' : kind === 'pop' ? 'Pop stash' : 'Drop stash'}
        </button>
      </div>
    </div>
  );
}

// --- shared -----------------------------------------------------------------

function Notice({
  title,
  tone,
  live,
  children,
}: {
  title: string;
  tone?: 'error';
  live?: boolean;
  children: ReactNode;
}): ReactNode {
  // A list that fails to load does it asynchronously, so the failure has to be
  // announced rather than merely drawn.
  const role = tone === 'error' ? 'alert' : live === true ? 'status' : undefined;
  return (
    <div
      className={`${styles.notice} ${tone === 'error' ? styles.noticeError : ''}`}
      role={role}
    >
      <strong className={styles.noticeTitle}>{title}</strong>
      <p className={styles.noticeText}>{children}</p>
    </div>
  );
}
