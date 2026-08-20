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

import { useEffect, useRef, useState, type ReactNode } from 'react';
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
type Deletion =
  { stage: 'safe'; name: string } | { stage: 'force'; name: string; warning: string };

type StashActionKind = 'apply' | 'pop' | 'drop';

interface StashQuestion {
  entry: StashEntry;
  kind: StashActionKind;
}

/** A stash that was dropped, and the oid that is the only way back to it. */
interface DropRecovery {
  label: string;
  oid: string;
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
  const [failure, setFailure] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<DropRecovery | null>(null);

  // Both lists are loaded for whatever repository is open, and re-loaded when
  // the user opens another one — a stale branch list belongs to a different
  // repository and every button on it would act on the wrong refs.
  useEffect(() => {
    if (root === null) return;
    void refreshBranches(store);
    void refreshStashes(store);
  }, [store, root]);

  const clearMessages = (): void => {
    setFailure(null);
    setOutcome(null);
    setRecovery(null);
  };

  const runDelete = async (pending: Deletion): Promise<void> => {
    clearMessages();
    const { name } = pending;
    const force = pending.stage === 'force';
    const reason = force ? forceDeleteBranchQuestion(name) : deleteBranchQuestion(name);

    const result = await removeBranch(store, name, reason, { force });
    if (result !== null && result.deleted) {
      setDeletion(null);
      setOutcome(`Deleted branch "${name}".`);
      return;
    }
    if (result !== null && result.unmergedWarning !== undefined) {
      // Ask again — a different question, with the warning attached. Nothing
      // here calls the action layer a second time on its own.
      setDeletion({ stage: 'force', name, warning: result.unmergedWarning });
      return;
    }
    setDeletion(null);
    setFailure(`Branch "${name}" was not deleted.`);
  };

  const runStashAction = async (pending: StashQuestion): Promise<void> => {
    clearMessages();
    setStashQuestion(null);
    const { entry, kind } = pending;
    // The oid travels with the ref: `stash@{1}` alone is a position, and
    // positions move.
    const target = { ref: entry.ref, oid: entry.oid };

    const done =
      kind === 'drop'
        ? await removeStash(store, target, dropStashQuestion(entry))
        : await restoreStash(
            store,
            target,
            { pop: kind === 'pop' },
            kind === 'pop' ? popStashQuestion(entry) : applyStashQuestion(entry),
          );

    if (!done) {
      setFailure(
        `${ACTION_NOUN[kind]} "${stashLabel(entry)}" did not run. The stash list has been re-read from git — entries shift whenever anything is stashed, so check the list below and act on the row you see now.`,
      );
      return;
    }
    if (kind === 'drop') {
      setRecovery({ label: stashLabel(entry), oid: entry.oid });
      return;
    }
    setOutcome(
      kind === 'pop'
        ? `Popped stash "${stashLabel(entry)}" — it is no longer in the list.`
        : `Applied stash "${stashLabel(entry)}" — it is still in the list.`,
    );
  };

  return (
    <section className={styles.panel} aria-label="Branches and stashes">
      {/*
        Messages sit above the lists: a drop leaves an oid that is the only
        route back to the work, and a list that reloads underneath must not take
        it off screen.
      */}
      {recovery !== null && (
        <div className={styles.recovery} role="status">
          <strong className={styles.noticeTitle}>
            Dropped stash &quot;{recovery.label}&quot;
          </strong>
          <p className={styles.noticeText}>
            The entry is gone from the list, but its commit survives until git collects
            it. Run this to bring the changes back:
          </p>
          <pre className={styles.noticeCommand}>
            <code>{dropRecoveryCommand(recovery.oid)}</code>
          </pre>
          <button
            type="button"
            className={styles.button}
            onClick={() => setRecovery(null)}
          >
            Dismiss
          </button>
        </div>
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

      {outcome !== null && (
        <div className={styles.outcome} role="status">
          <p className={styles.noticeText}>{outcome}</p>
          <button
            type="button"
            className={styles.button}
            onClick={() => setOutcome(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {deletion !== null && (
        <DeleteConfirmation
          deletion={deletion}
          busy={busy}
          onCancel={() => setDeletion(null)}
          onConfirm={() => void runDelete(deletion)}
        />
      )}

      {stashQuestion !== null && (
        <StashConfirmation
          question={stashQuestion}
          busy={busy}
          onCancel={() => setStashQuestion(null)}
          onConfirm={() => void runStashAction(stashQuestion)}
        />
      )}

      <div className={styles.body}>
        <BranchesSection
          busy={busy}
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
            clearMessages();
            // Always the safe stage: force is unreachable from a click.
            setDeletion({ stage: 'safe', name });
          }}
        />

        <StashesSection
          busy={busy}
          onAsk={(entry, kind) => {
            clearMessages();
            setStashQuestion({ entry, kind });
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
      <label className={styles.createLabel} htmlFor="refs-new-branch">
        New branch
      </label>
      <input
        id="refs-new-branch"
        className={styles.input}
        value={name}
        disabled={busy}
        placeholder="feature/my-change"
        aria-invalid={error !== null}
        aria-describedby={error === null ? undefined : 'refs-new-branch-error'}
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
        <p id="refs-new-branch-error" className={styles.fieldError} role="alert">
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

  // The safe choice takes focus, and takes it again when the question changes
  // to the forcing one: a keystroke aimed at the first question must never
  // land on the second, which drops commits.
  useEffect(() => {
    cancelRef.current?.focus();
  }, [deletion.stage]);

  const forcing = deletion.stage === 'force';
  const question = forcing
    ? forceDeleteBranchQuestion(deletion.name)
    : deleteBranchQuestion(deletion.name);

  return (
    <div
      className={styles.confirm}
      role="alertdialog"
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
  return (
    <div
      className={`${styles.notice} ${tone === 'error' ? styles.noticeError : ''}`}
      role={live === true ? 'status' : undefined}
    >
      <strong className={styles.noticeTitle}>{title}</strong>
      <p className={styles.noticeText}>{children}</p>
    </div>
  );
}
