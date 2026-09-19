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

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FileListMode } from '../../config/schema';
import type { Branch, StashEntry, Tag } from '../../git/types';
import {
  createAndSwitch,
  refreshBranches,
  refreshStashes,
  refreshTags,
  pushTagTo,
  removeBranch,
  removeRemoteBranch,
  removeRemoteTag,
  removeStash,
  removeTag,
  restoreStash,
  selectCommit,
  switchTo,
} from '../../state/actions';
import { useAppState, useStore } from '../../state/hooks';
import { isBusy } from '../../state/store';
import { buildStashMenu } from '../history/commitMenu';
import { useAutoDismiss } from '../shell/autoDismiss';
import { copyText } from '../shell/clipboard';
import { ContextMenu, type MenuSection } from '../shell/ContextMenu';
import {
  BranchIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  RepoIcon,
  StashIcon,
  TagIcon,
} from '../shell/icons';
import { buildPathTree, type PathNode } from '../shell/pathTree';
import { shortRefName } from '../shell/refName';
import { trapTab } from '../shell/trapTab';
import { rememberConfig } from '../shell/useLayout';
import styles from './RefsView.module.css';
import {
  applyStashQuestion,
  branchAncestors,
  branchNameError,
  branchRef,
  deleteRemoteTagDetail,
  deleteTagDetail,
  deleteBranchQuestion,
  deleteRemoteTagQuestion,
  deleteTagQuestion,
  dropRecoveryCommand,
  dropStashQuestion,
  deleteRemoteBranchQuestion,
  forceDeleteBranchQuestion,
  formatRelativeDate,
  groupBranches,
  isBranchSelected,
  isTagSelected,
  localNameFor,
  popStashQuestion,
  remoteDeleteRecovery,
  remoteTagDeleteRecovery,
  splitRemoteBranch,
  stashLabel,
  tagRef,
  tagRestoreCommand,
  trackingSummary,
  type RemoteRef,
  type RemoteTagRef,
} from './labels';
import { buildTagMenu, tagSummary } from './tagMenu';
import { preferredRemote } from '../remote/remotes';

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

/**
 * The remote-delete question on screen, if any.
 *
 * It carries the oid the row was drawn with, because that number is the way
 * back and it stops existing the moment the next fetch prunes the ref. Its own
 * type rather than a stage of {@link Deletion}: a local delete git refuses can
 * be escalated, and a remote delete has nothing to escalate to — it either
 * happened on the server or it did not.
 */
interface RemoteDeletion {
  ref: RemoteRef;
  /** Full name as the panel shows it, for the sentences about it. */
  name: string;
  oid: string;
  root: string;
}

/**
 * The tag delete on screen, if any.
 *
 * It carries the object the row was drawn with, because that is the way back
 * and it stops being usable once git collects it. `remote` is set when the
 * delete is the one that reaches a server — a different question with a
 * different blast radius, so it is a field rather than a second type only in
 * the sense that everything else about the two is identical.
 */
interface TagDeletion {
  tag: Tag;
  /** The remote this goes to, or `null` for the local delete. */
  remote: string | null;
  root: string;
}

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

/**
 * Outcome of a branch creation. The cause travels with it because the action
 * layer reports failure only as a boolean plus a store notice, and both the
 * field and the remote rows need to say more than "no".
 */
interface CreateResult {
  ok: boolean;
  cause: string | null;
}

type CreateBranch = (name: string, startPoint?: string) => Promise<CreateResult>;

export function RefsView(): ReactNode {
  const store = useStore();
  const busy = useAppState(isBusy);
  const selectedOid = useAppState((state) => state.selection.commitOid);
  const selectedRef = useAppState((state) => state.selection.ref);
  const root = useAppState((state) =>
    state.repo.state === 'ready' ? state.repo.value.root : null,
  );

  const [deletion, setDeletion] = useState<Deletion | null>(null);
  const [remoteDeletion, setRemoteDeletion] = useState<RemoteDeletion | null>(null);
  const [tagDeletion, setTagDeletion] = useState<TagDeletion | null>(null);
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
    void refreshTags(store);
    void refreshStashes(store);
  }, [store, root]);

  // Leaving a repository forgets every question and message asked about it, so
  // coming back cannot resurrect a stale warning as though it were fresh
  // evidence. Adjusted during render rather than in an effect: the state is
  // derived from which repository is open, and an effect would let one paint
  // happen first. `recovery` is exempt on purpose — it names its own
  // repository and is the only route back to work that was dropped.
  const [lastRoot, setLastRoot] = useState(root);
  if (root !== lastRoot) {
    setLastRoot(root);
    setDeletion(null);
    setStashQuestion(null);
    setTagDeletion(null);
    setFailure(null);
    setOutcome(null);
  }

  // Belt and braces for the same rule: branch names collide across
  // repositories and the action layer resolves the root from current state, so
  // nothing asked about repository A is ever rendered over repository B.
  const openDeletion = deletion !== null && deletion.root === root ? deletion : null;
  const openStashQuestion =
    stashQuestion !== null && stashQuestion.root === root ? stashQuestion : null;
  const openRemoteDeletion =
    remoteDeletion !== null && remoteDeletion.root === root ? remoteDeletion : null;
  const openTagDeletion =
    tagDeletion !== null && tagDeletion.root === root ? tagDeletion : null;
  const shownFailure = failure !== null && failure.root === root ? failure : null;
  const shownOutcome = outcome !== null && outcome.root === root ? outcome : null;

  // Each of this panel's three notices dismisses itself after ten seconds
  // (ADR-0051). The keys carry the repository as well as the text, so switching
  // to another repository and back is a new notice with a fresh clock rather
  // than one that expires early on a timer the user never saw start.
  useAutoDismiss(recovery === null ? null : `${recovery.root}:${recovery.oid}`, () => {
    setRecovery(null);
  });
  useAutoDismiss(
    shownFailure === null ? null : `${shownFailure.root}:${shownFailure.text}`,
    () => {
      setFailure(null);
    },
  );
  useAutoDismiss(
    shownOutcome === null ? null : `${shownOutcome.root}:${shownOutcome.text}`,
    () => {
      setOutcome(null);
    },
  );

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

  /** Repository open right now, straight from the store rather than the render. */
  const openRoot = (): string | null => {
    const repo = store.getState().repo;
    return repo.state === 'ready' ? repo.value.root : null;
  };

  /** True while the question still applies to the repository that is open. */
  const stillCurrent = (askedAbout: string): boolean => openRoot() === askedAbout;

  /**
   * Reports a refusal against the repository the user is looking at.
   *
   * Messages are scoped to a root so they cannot follow the user into another
   * repository — which means one about *leaving* a repository has to be filed
   * under the new one, or it would be filed where nobody can read it.
   */
  const reportHere = (text: string, cause: string | null): void => {
    const here = openRoot();
    if (here === null) return;
    setFailure({ text, cause, root: here });
  };

  /**
   * Switches branches, saying so when git refused.
   *
   * A refused switch is the quietest dangerous outcome in this panel: git
   * declines (uncommitted changes would be overwritten), the list refreshes
   * back to the branch the user is still on, and the only cue is a one-glyph
   * marker. Work then goes to the branch they believed they had left.
   */
  const runSwitch = async (name: string): Promise<void> => {
    if (running) return;
    const [ok, cause] = await perform(() => switchTo(store, name));
    if (!ok)
      reportHere(`Could not switch to "${name}". You are still where you were.`, cause);
  };

  const runDelete = async (pending: Deletion): Promise<void> => {
    if (running) return;
    clearMessages();
    const { name } = pending;
    if (!stillCurrent(pending.root)) {
      setDeletion(null);
      reportHere(
        `Nothing was deleted: the open repository changed after the question about "${name}" was asked.`,
        null,
      );
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
    const warning = result === null ? undefined : result.unmergedWarning;
    if (warning !== undefined) {
      // Ask again — a different question, with the warning attached. Nothing
      // here calls the action layer a second time on its own, and the forcing
      // button arrives disarmed (see DeleteConfirmation). Only the question
      // that is still on screen is escalated: a user who cancelled while the
      // safe attempt was in flight must not have a destructive dialog reopened
      // on them.
      setDeletion((current) =>
        current !== null && current.stage === 'safe' && current.name === pending.name
          ? { ...pending, stage: 'force', warning }
          : current,
      );
      return;
    }
    setDeletion(null);
    setFailure({ text: `Branch "${name}" was not deleted.`, cause, root: pending.root });
  };

  /**
   * Deletes a branch on the remote, once the user has said so.
   *
   * There is no second stage here and no forcing: git does not refuse this the
   * way it refuses an unmerged local delete, so the confirmation is the only
   * gate on this side and the server's own protections are the other. The
   * recovery command is built from the oid the row was drawn with, *before*
   * the delete, because the refresh that follows prunes the ref it came from.
   */
  const runRemoteDelete = async (pending: RemoteDeletion): Promise<void> => {
    if (running) return;
    clearMessages();
    const { ref, name } = pending;
    if (!stillCurrent(pending.root)) {
      setRemoteDeletion(null);
      reportHere(
        `Nothing was deleted: the open repository changed after the question about "${name}" was asked.`,
        null,
      );
      return;
    }

    setRemoteDeletion(null);
    const [ok, cause] = await perform(() =>
      removeRemoteBranch(
        store,
        ref,
        deleteRemoteBranchQuestion(ref),
        remoteDeleteRecovery(ref, pending.oid),
      ),
    );
    if (ok) {
      setOutcome({ text: `Deleted "${name}" on ${ref.remote}.`, root: pending.root });
      return;
    }
    setFailure({
      text: `"${name}" was not deleted. It is still on ${ref.remote}.`,
      cause,
      root: pending.root,
    });
  };

  /**
   * Deletes a tag, locally or on a remote, and says how to put it back.
   *
   * One function for both because they differ in exactly two things — the
   * question and the command — and having two copies of the
   * "did the repository change while the question was up?" guard is how one of
   * them ends up missing it.
   */
  const runTagDelete = async (pending: TagDeletion): Promise<void> => {
    if (running) return;
    clearMessages();
    const { tag, remote } = pending;
    setTagDeletion(null);
    if (!stillCurrent(pending.root)) {
      reportHere(
        `Nothing was deleted: the open repository changed after the question about "${tag.name}" was asked.`,
        null,
      );
      return;
    }

    if (remote === null) {
      const [ok, cause] = await perform(() =>
        removeTag(store, tag.name, deleteTagQuestion(tag.name), tagRestoreCommand(tag)),
      );
      if (ok) {
        // The object id is in the sentence, not only in the notice's undo hint:
        // a tag has no reflog, so once both have gone the only route left is
        // `git fsck --dangling`, and a notice lives ten seconds (ADR-0051).
        setOutcome({
          text: `Deleted tag "${tag.name}", which pointed at ${tag.object.slice(0, 12)}.`,
          root: pending.root,
        });
        return;
      }
      setFailure({
        text: `Tag "${tag.name}" was not deleted.`,
        cause,
        root: pending.root,
      });
      return;
    }

    const ref: RemoteTagRef = { remote, tag: tag.name };
    const [outcome, cause] = await perform(() =>
      removeRemoteTag(
        store,
        ref,
        deleteRemoteTagQuestion(ref),
        remoteTagDeleteRecovery(ref, tag.object),
      ),
    );
    // `nothing-there` is not a failure and must not be reported as one — but
    // it is certainly not "deleted" either. The action's own notice says which
    // of the two happened; this line only stops the panel claiming the first.
    if (outcome === 'nothing-there') return;
    if (outcome === 'deleted') {
      setOutcome({
        text: `Deleted tag "${tag.name}" on ${remote}. It is still here, on ${tag.object.slice(0, 12)}.`,
        root: pending.root,
      });
      return;
    }
    setFailure({
      text: `Tag "${tag.name}" was not deleted. It may still be on ${remote}.`,
      cause,
      root: pending.root,
    });
  };

  const runStashAction = async (pending: StashQuestion): Promise<void> => {
    if (running) return;
    clearMessages();
    setStashQuestion(null);
    const { entry, kind } = pending;
    if (!stillCurrent(pending.root)) {
      reportHere(
        `Nothing was done: the open repository changed after the question about "${stashLabel(entry)}" was asked.`,
        null,
      );
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
    <section className={styles.panel} aria-label="Branches, tags and stashes">
      {/*
        The open question comes first, so a notice appearing or being dismissed
        underneath it cannot shift a destructive button under the pointer. Only
        one question is ever on screen.
      */}
      {openDeletion !== null && (
        <DeleteConfirmation
          // Keyed by branch and stage: any new question is a fresh component,
          // so it can never inherit the armed state of the one it replaced.
          key={`${openDeletion.stage}:${openDeletion.name}`}
          deletion={openDeletion}
          busy={locked}
          onCancel={() => setDeletion(null)}
          onConfirm={() => void runDelete(openDeletion)}
        />
      )}

      {openRemoteDeletion !== null && (
        <RemoteDeleteConfirmation
          key={openRemoteDeletion.name}
          deletion={openRemoteDeletion}
          busy={locked}
          onCancel={() => setRemoteDeletion(null)}
          onConfirm={() => void runRemoteDelete(openRemoteDeletion)}
        />
      )}

      {openTagDeletion !== null && (
        <TagDeleteConfirmation
          key={`${openTagDeletion.remote ?? 'local'}:${openTagDeletion.tag.name}`}
          deletion={openTagDeletion}
          busy={locked}
          onCancel={() => setTagDeletion(null)}
          onConfirm={() => void runTagDelete(openTagDeletion)}
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
        notice outlives the lists reloading underneath it and every later click
        — but not the ten-second timer every notice now carries (ADR-0051).
        After that the stash commit is still there and `git fsck --unreachable`
        is what finds it.
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
          selectedRef={selectedRef}
          // Reading a branch is a selection, never a checkout: the diff panel
          // shows what the commit at its tip changed, and nothing on disk
          // moves. The branch's own ref path travels with it so the row that
          // was clicked is the row that lights up, rather than every ref that
          // happens to sit on that commit.
          onSelect={(branch) => {
            clearMessages();
            void selectCommit(store, branch.oid, branchRef(branch));
          }}
          onSwitch={(name) => {
            clearMessages();
            void runSwitch(name);
          }}
          onCreate={async (name, startPoint) => {
            clearMessages();
            const [ok, cause] = await perform(() =>
              createAndSwitch(store, name, startPoint),
            );
            return { ok, cause };
          }}
          onAskDelete={(name) => {
            if (root === null) return;
            clearMessages();
            setStashQuestion(null);
            setRemoteDeletion(null);
            // Always the safe stage: force is unreachable from a click.
            setDeletion({ stage: 'safe', name, root });
          }}
          onAskDeleteRemote={(branch) => {
            if (root === null) return;
            const ref = splitRemoteBranch(branch.name);
            if (ref === null) return;
            clearMessages();
            setStashQuestion(null);
            setDeletion(null);
            setRemoteDeletion({ ref, name: branch.name, oid: branch.oid, root });
          }}
        />

        <TagsSection
          busy={locked}
          selectedOid={selectedOid}
          selectedRef={selectedRef}
          onSelect={(tag) => {
            clearMessages();
            void selectCommit(store, tag.oid, tagRef(tag));
          }}
          onAskDelete={(tag, remote) => {
            if (root === null) return;
            clearMessages();
            setDeletion(null);
            setRemoteDeletion(null);
            setStashQuestion(null);
            setTagDeletion({ tag, remote, root });
          }}
        />

        <StashesSection
          busy={locked}
          selectedOid={selectedOid}
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

// --- collapsible headers -----------------------------------------------------

/**
 * The header of a section, doubling as the control that opens and closes it.
 *
 * The count stays on the header while the section is shut, so a collapsed
 * section still says how much is hidden inside it. The heading element wraps
 * the button rather than the other way round: a button may only contain
 * phrasing content, and the outline a screen reader builds from this panel has
 * to survive the sections becoming collapsible.
 */
function CollapsibleHeader({
  level,
  title,
  icon,
  count,
  open,
  bodyId,
  onToggle,
}: {
  level: 'section' | 'subsection';
  title: string;
  icon?: ReactNode;
  count: number | null;
  open: boolean;
  bodyId: string;
  onToggle: () => void;
}): ReactNode {
  const Heading = level === 'section' ? 'h2' : 'h3';
  const isSection = level === 'section';

  return (
    <Heading className={styles.heading}>
      <button
        type="button"
        className={isSection ? styles.sectionHeader : styles.subsectionHeader}
        // The count is a badge on screen; spelled into the name it would read
        // as "Branches3", so the name carries it as its own phrase instead.
        aria-label={count === null ? title : `${title}, ${String(count)}`}
        aria-expanded={open}
        aria-controls={bodyId}
        title={open ? `Collapse ${title}` : `Expand ${title}`}
        onClick={onToggle}
      >
        <span className={styles.chevron} aria-hidden="true">
          {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        </span>
        {icon}
        <span className={isSection ? styles.sectionTitle : styles.subsectionTitle}>
          {title}
        </span>
        {count !== null && (
          <span className={styles.count} aria-hidden="true">
            {count}
          </span>
        )}
      </button>
    </Heading>
  );
}

// --- branches ---------------------------------------------------------------

function BranchesSection({
  busy,
  selectedOid,
  selectedRef,
  onSelect,
  onSwitch,
  onCreate,
  onAskDelete,
  onAskDeleteRemote,
}: {
  busy: boolean;
  selectedOid: string | null;
  selectedRef: string | null;
  onSelect: (branch: Branch) => void;
  onSwitch: (name: string) => void;
  onCreate: CreateBranch;
  onAskDelete: (name: string) => void;
  onAskDeleteRemote: (branch: Branch) => void;
}): ReactNode {
  const branches = useAppState((state) => state.branches);
  const config = useAppState((state) => state.config);
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  /*
    One setting for Local and Remote alike. `feat/x` and `origin/feat/x` are
    the same naming habit seen from two sides, and a user who asks for a tree
    is asking it of the panel, not of one of its halves.
  */
  const mode = config.branchList;
  const setMode = (next: FileListMode): void => {
    if (next !== mode) rememberConfig({ ...config, branchList: next });
  };

  return (
    <section className={styles.section} aria-label="Branches">
      {/* The switch sits beside the header rather than inside it: the header is
          itself a button, and a button may not contain another one. */}
      <div className={styles.sectionBar}>
        <CollapsibleHeader
          level="section"
          title="Branches"
          icon={<BranchIcon size={13} />}
          count={branches.state === 'ready' ? branches.value.length : null}
          open={open}
          bodyId={bodyId}
          onToggle={() => setOpen((was) => !was)}
        />
        {/* Gone with the section it redraws: a switch over a list nobody
            can see is a setting changed blind. */}
        {open && <ListModeToggle mode={mode} onMode={setMode} />}
      </div>

      <div id={bodyId} hidden={!open}>
        <CreateBranchForm busy={busy} selectedOid={selectedOid} onCreate={onCreate} />

        {branches.state === 'idle' && (
          <Notice title="No repository open">
            Open a repository to see its branches.
          </Notice>
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
            mode={mode}
            selectedOid={selectedOid}
            selectedRef={selectedRef}
            onSelect={onSelect}
            onSwitch={onSwitch}
            onCreate={onCreate}
            onAskDelete={onAskDelete}
            onAskDeleteRemote={onAskDeleteRemote}
          />
        )}
      </div>
    </section>
  );
}

/** The List / Tree switch, the same control the file lists carry. */
function ListModeToggle({
  mode,
  onMode,
}: {
  mode: FileListMode;
  onMode: (mode: FileListMode) => void;
}): ReactNode {
  return (
    <div className={styles.modeToggle} role="group" aria-label="Branch list layout">
      <button
        type="button"
        className={styles.modeButton}
        aria-pressed={mode === 'flat'}
        title="Show each branch with its full name"
        onClick={() => onMode('flat')}
      >
        List
      </button>
      <button
        type="button"
        className={styles.modeButton}
        aria-pressed={mode === 'tree'}
        title="Group branches by the parts of their names before each slash"
        onClick={() => onMode('tree')}
      >
        Tree
      </button>
    </div>
  );
}

function BranchLists({
  branches,
  busy,
  mode,
  selectedOid,
  selectedRef,
  onSelect,
  onSwitch,
  onCreate,
  onAskDelete,
  onAskDeleteRemote,
}: {
  branches: readonly Branch[];
  busy: boolean;
  mode: FileListMode;
  selectedOid: string | null;
  selectedRef: string | null;
  onSelect: (branch: Branch) => void;
  onSwitch: (name: string) => void;
  onCreate: CreateBranch;
  onAskDelete: (name: string) => void;
  onAskDeleteRemote: (branch: Branch) => void;
}): ReactNode {
  const { local, remote } = groupBranches(branches);
  /*
    `selectedRef` is passed down as it is, and the oid fallback lives in
    `isRefSelected` where it fires only for a selection that named no ref at
    all. Filtering it to "a ref this list holds" was wrong in the one case the
    whole design exists for: selecting the tag `v1.0` named a ref no branch
    answers to, the list fell back to the oid, and every branch sitting on that
    commit lit up — the question nobody asked. A ref that no longer exists
    highlights nothing, which is the truth about it.
  */

  return (
    <>
      <BranchSubsection
        title="Local"
        label="Local branches"
        empty="No local branches yet."
        branches={local}
        mode={mode}
        selectedRef={selectedRef}
        renderRow={(branch, label, tree) => (
          <LocalRow
            key={branch.name}
            branch={branch}
            label={label}
            tree={tree}
            busy={busy}
            named={selectedRef === branchRef(branch)}
            selected={isBranchSelected(branch, selectedRef, selectedOid)}
            onSelect={onSelect}
            onSwitch={onSwitch}
            onAskDelete={onAskDelete}
          />
        )}
      />

      <BranchSubsection
        title="Remote"
        label="Remote branches"
        icon={<RepoIcon size={12} />}
        empty="No remote-tracking branches."
        branches={remote}
        mode={mode}
        selectedRef={selectedRef}
        renderRow={(branch, label, tree) => (
          <RemoteRow
            key={branch.name}
            branch={branch}
            label={label}
            tree={tree}
            busy={busy}
            named={selectedRef === branchRef(branch)}
            selected={isBranchSelected(branch, selectedRef, selectedOid)}
            onSelect={onSelect}
            onCreate={onCreate}
            onAskDelete={onAskDeleteRemote}
          />
        )}
      />
    </>
  );
}

/**
 * One half of the branch list — Local or Remote — drawn flat or as a tree.
 *
 * Both halves behave the same way, so they are one component: what differs is
 * the heading and what a row offers to do, and the second is a prop. The tree
 * is the builder the working-tree and diff file lists already use, over the
 * slashes in a branch name instead of the slashes in a path. A remote name
 * carries its remote as its first segment, which is how `origin` becomes a row
 * of its own without anything here knowing what a remote is.
 */
function BranchSubsection({
  title,
  label,
  icon,
  empty,
  branches,
  mode,
  selectedRef,
  renderRow,
}: {
  title: string;
  label: string;
  icon?: ReactNode;
  empty: string;
  branches: readonly Branch[];
  mode: FileListMode;
  selectedRef: string | null;
  renderRow: (branch: Branch, label: string, tree: boolean) => ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(true);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const bodyId = useId();
  const tree = useMemo(
    () => (mode === 'tree' ? buildPathTree(branches, (branch) => branch.name) : []),
    [mode, branches],
  );
  const holdsSelection =
    selectedRef !== null && branches.some((branch) => branchRef(branch) === selectedRef);

  /*
    A selection made somewhere else — a chip clicked in the history — has to
    end up visible here, or the row it highlights is drawn inside a section
    that is shut. Only what stands between that row and the eye is opened:
    groups folded away elsewhere in the list stay folded, and so does this
    section once the user closes it again over the same selection.

    Adjusted during render rather than in an effect, the way this panel already
    reacts to the open repository changing: an effect would let one paint
    happen with the highlight drawn where nobody can see it.
  */
  const named = holdsSelection ? selectedRef : null;
  const [lastNamed, setLastNamed] = useState(named);
  if (named !== lastNamed) {
    setLastNamed(named);
    if (named !== null) {
      setOpen(true);
      setFolded((was) => {
        const shut = branchAncestors(shortRefName(named)).filter((path) => was.has(path));
        if (shut.length === 0) return was;
        const next = new Set(was);
        for (const path of shut) next.delete(path);
        return next;
      });
    }
  }

  const toggleDir = (path: string): void => {
    setFolded((was) => {
      const next = new Set(was);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  };

  return (
    <section className={styles.subsection} aria-label={label}>
      <CollapsibleHeader
        level="subsection"
        title={title}
        icon={icon}
        count={branches.length}
        open={open}
        bodyId={bodyId}
        onToggle={() => setOpen((was) => !was)}
      />
      <div id={bodyId} hidden={!open}>
        {branches.length === 0 ? (
          <p className={styles.empty}>{empty}</p>
        ) : mode === 'tree' ? (
          <ul className={styles.list} role="tree" aria-label={`${label} tree`}>
            {tree.map((node) => (
              <BranchTreeRow
                key={node.kind === 'dir' ? `dir:${node.path}` : node.path}
                node={node}
                folded={folded}
                onToggle={toggleDir}
                renderRow={renderRow}
              />
            ))}
          </ul>
        ) : (
          <ul className={styles.list}>
            {branches.map((branch) => renderRow(branch, branch.name, false))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** A name segment and everything under it, or one branch row. */
function BranchTreeRow({
  node,
  folded,
  onToggle,
  renderRow,
}: {
  node: PathNode<Branch>;
  folded: ReadonlySet<string>;
  onToggle: (path: string) => void;
  renderRow: (branch: Branch, label: string, tree: boolean) => ReactNode;
}): ReactNode {
  if (node.kind === 'file') return renderRow(node.item, node.name, true);

  const open = !folded.has(node.path);
  return (
    <li role="treeitem" aria-expanded={open} aria-selected={false}>
      <button
        type="button"
        className={styles.treeDir}
        aria-expanded={open}
        title={node.path}
        onClick={() => onToggle(node.path)}
      >
        <span className={styles.treeChevron} aria-hidden="true">
          ▾
        </span>
        <span className={styles.treeDirName}>{node.name}</span>
      </button>
      {open && (
        <ul className={styles.treeChildren} role="group">
          {node.children.map((child) => (
            <BranchTreeRow
              key={child.kind === 'dir' ? `dir:${child.path}` : child.path}
              node={child}
              folded={folded}
              onToggle={onToggle}
              renderRow={renderRow}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/** A local branch: read it, check it out, or delete it. */
function LocalRow({
  branch,
  label,
  tree,
  busy,
  named,
  selected,
  onSelect,
  onSwitch,
  onAskDelete,
}: {
  branch: Branch;
  label: string;
  /** Drawn inside the tree, where the row is an item of it. */
  tree: boolean;
  busy: boolean;
  /** The row the selection named, as opposed to one merely on its commit. */
  named: boolean;
  selected: boolean;
  onSelect: (branch: Branch) => void;
  onSwitch: (name: string) => void;
  onAskDelete: (name: string) => void;
}): ReactNode {
  return (
    <li
      className={styles.row}
      role={tree ? 'treeitem' : undefined}
      aria-selected={tree ? selected : undefined}
    >
      <BranchButton
        branch={branch}
        label={label}
        busy={busy}
        named={named}
        selected={selected}
        onSelect={onSelect}
      />
      <Divergence branch={branch} />
      {/* Checking out is the thing that moves files, so it is the thing that
          says so on its face, rather than something a click on a name does
          silently. */}
      <button
        type="button"
        className={styles.button}
        disabled={busy || branch.current}
        title={
          branch.current
            ? `${branch.name} is already checked out.`
            : `Check out ${branch.name}. This changes the files in your working tree.`
        }
        onClick={() => onSwitch(branch.name)}
      >
        Switch
      </button>
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
  );
}

/**
 * A branch row's name, which *selects* rather than checks out.
 *
 * Clicking it used to run `git switch`. In a repository with a lot of
 * uncommitted work that is the most expensive thing the app can do by
 * accident: git either churns the whole working tree or refuses, the window
 * blocks while it decides, and the list then redraws on whatever branch it
 * ended up on. Reading a branch is not a reason to move anyone's files.
 *
 * So a click answers "what is on this branch?" — it selects the commit the
 * branch points at, and the diff panel shows what that commit changed.
 * Checking out is still one click away, on its own button that says so.
 *
 * Remote-tracking rows use it too: reading `origin/main` is the same question
 * as reading `main`, and a row that cannot be selected is a row a chip in the
 * history has no way to point at.
 */
function BranchButton({
  branch,
  label,
  busy,
  named,
  selected,
  onSelect,
}: {
  branch: Branch;
  /** What the row prints — the last segment only, in the tree. */
  label: string;
  busy: boolean;
  /** The row the selection named, as opposed to one merely on its commit. */
  named: boolean;
  selected: boolean;
  onSelect: (branch: Branch) => void;
}): ReactNode {
  const ref = useRef<HTMLButtonElement>(null);

  /*
    A selection can arrive from the history, where the user clicked a chip and
    never touched this panel. The row it names is routinely below the fold of a
    sidebar holding fifty branches, so a highlight alone would be drawn where
    nobody can see it. `nearest` scrolls the least that gets it on screen, and
    only this panel scrolls: the row is not focused, so nothing is taken from
    wherever the user was typing.

    Only the row the selection *named* does this. In the oid fallback several
    rows are marked at once — a branch and its remote-tracking twin — and an
    ordinary click on a commit row in the history would otherwise drag the
    sidebar to whichever of them rendered, which nobody asked it to do.
  */
  useEffect(() => {
    // Not in jsdom, and not worth a polyfill: the highlight is what the tests
    // are about, and the scroll is what a browser adds to it.
    if (named) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [named]);

  return (
    <button
      ref={ref}
      type="button"
      className={`${styles.name} ${branch.current ? styles.current : ''} ${
        selected ? styles.nameSelected : ''
      }`}
      disabled={busy}
      aria-current={branch.current ? 'true' : undefined}
      aria-pressed={selected}
      // A remote-tracking row's tooltip carries the whole name because the row
      // usually cannot: what tells two remote branches apart is the tail
      // (`origin/chore/…`), and `trackingSummary` on one of them is always the
      // useless "No upstream branch".
      title={
        branch.remote
          ? `${branch.name} — show the commit it points at`
          : `Show the commit ${branch.name} points at. ${trackingSummary(branch)}`
      }
      onClick={() => onSelect(branch)}
    >
      <span aria-hidden="true" className={styles.marker}>
        {branch.current ? '●' : '○'}
      </span>
      {/* Clipped at the front: a bare text node cannot be ellipsised at all,
          and `feature/…` prefixes are what long names share. */}
      <span className={`${styles.nameText} ${styles.nameTail}`}>
        <bdi>{label}</bdi>
      </span>
      {branch.current && <span className={styles.srOnly}> (current branch)</span>}
      {/* In the tree the row prints one segment, so the name a screen reader
          hears — and a test looks a row up by — would otherwise be the segment
          alone, which several branches share. */}
      {label !== branch.name && <span className={styles.srOnly}> in {branch.name}</span>}
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
  label,
  tree,
  busy,
  named,
  selected,
  onSelect,
  onCreate,
  onAskDelete,
}: {
  branch: Branch;
  label: string;
  /** Drawn inside the tree, where the row is an item of it. */
  tree: boolean;
  busy: boolean;
  /** The row the selection named, as opposed to one merely on its commit. */
  named: boolean;
  selected: boolean;
  onSelect: (branch: Branch) => void;
  onCreate: CreateBranch;
  onAskDelete: (branch: Branch) => void;
}): ReactNode {
  const local = localNameFor(branch);
  // No delete for a name this panel cannot split into a remote and a branch:
  // the push would have to guess which half is which, and guessing wrong
  // deletes a ref on a server.
  const deletable = splitRemoteBranch(branch.name) !== null;
  const [error, setError] = useState<string | null>(null);

  const checkout = async (name: string): Promise<void> => {
    setError(null);
    const { ok, cause } = await onCreate(name, branch.name);
    if (!ok) {
      // Silence here would read as "done": the row's only other feedback is the
      // branch appearing in the local list, which a refresh could explain away.
      setError(
        cause === null
          ? `Local branch "${name}" was not created from ${branch.name}.`
          : `Local branch "${name}" was not created from ${branch.name}. git said: ${cause}`,
      );
    }
  };

  return (
    <li
      className={styles.row}
      role={tree ? 'treeitem' : undefined}
      aria-selected={tree ? selected : undefined}
    >
      <BranchButton
        branch={branch}
        label={label}
        busy={busy}
        named={named}
        selected={selected}
        onSelect={onSelect}
      />
      <Divergence branch={branch} />
      {local === null ? (
        <span className={styles.hint}>No local name can be derived</span>
      ) : (
        <button
          type="button"
          className={styles.button}
          disabled={busy}
          // The visible label is fixed-width on purpose. It used to name the
          // branch, which made every row's button a different width — and
          // since the button never shrinks, the branch name beside it was
          // squeezed down to two or three letters. The name is what the row
          // exists to show, so it moves into the accessible name and the
          // tooltip, which is also what keeps two rows' buttons apart for a
          // screen reader.
          aria-label={`Check out as ${local}`}
          title={`Create local branch ${local} from ${branch.name} and switch to it`}
          onClick={() => void checkout(local)}
        >
          Check out
        </button>
      )}
      {deletable && (
        <button
          type="button"
          className={`${styles.button} ${styles.danger}`}
          disabled={busy}
          // Named for a screen reader, fixed-width on screen, for the same
          // reason the Check out button is: the branch name is what the row
          // exists to show and must not be squeezed by its own buttons.
          aria-label={`Delete ${branch.name} on the remote`}
          title={`Delete ${branch.name} on the remote. It disappears for everyone who fetches from it.`}
          onClick={() => onAskDelete(branch)}
        >
          Delete
        </button>
      )}
      {error !== null && (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/**
 * The remote-delete question.
 *
 * One stage, and no arming checkbox: there is nothing to escalate to, because
 * git does not refuse this the way it refuses an unmerged local delete. What
 * it does have instead is the sentence saying the branch goes for everyone,
 * and Cancel with the focus — the same rule the other questions here follow, so
 * a stray Enter never deletes anything.
 */
function RemoteDeleteConfirmation({
  deletion,
  busy,
  onCancel,
  onConfirm,
}: {
  deletion: RemoteDeletion;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactNode {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <div
      className={styles.confirm}
      role="alertdialog"
      aria-modal="true"
      aria-label="Confirm remote branch delete"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
        trapTab(event);
      }}
    >
      <strong className={styles.noticeTitle}>
        {deleteRemoteBranchQuestion(deletion.ref)}
      </strong>
      <p className={styles.noticeText}>
        This removes the branch name on the server, not the commits: they stay there until
        it collects them, and they are in this repository right now. Krakenless will offer
        the push that puts the branch back.
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
          className={`${styles.button} ${styles.danger}`}
          disabled={busy}
          onClick={onConfirm}
        >
          Delete on {deletion.ref.remote}
        </button>
      </div>
    </div>
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
  onCreate: CreateBranch;
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
    const { ok, cause } = await onCreate(
      candidate,
      useSelected && selectedOid !== null ? selectedOid : undefined,
    );
    if (!ok) {
      // Git's own words when there are any: "was not created" alone leaves the
      // user guessing between a name that already exists and a dirty tree.
      setError(
        cause === null
          ? `Branch "${candidate}" was not created.`
          : `Branch "${candidate}" was not created. git said: ${cause}`,
      );
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
        trapTab(event);
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

/** The stash whose context menu is open, and where the pointer opened it. */
interface TagMenuTarget {
  tag: Tag;
  x: number;
  y: number;
}

/**
 * The tag list.
 *
 * Its own section rather than a third branch list: a tag is not somewhere work
 * happens, and the two things a user does with one — read what it points at,
 * and get rid of it — are not the two things they do with a branch. There is no
 * Switch, because checking out a tag detaches HEAD and that is the commit
 * menu's question to ask.
 *
 * Deleting is a visible button for the reason the branch rows have one: it is
 * the thing this list exists to make possible, and hunting for it in a menu is
 * how a user concludes the app cannot do it. Everything else — pushing, the
 * delete that reaches a server, copying — is on the row's context menu, built
 * by {@link buildTagMenu} so the offers are decided in a tested function
 * rather than in the markup.
 */
function TagsSection({
  busy,
  selectedOid,
  selectedRef,
  onSelect,
  onAskDelete,
}: {
  busy: boolean;
  selectedOid: string | null;
  selectedRef: string | null;
  onSelect: (tag: Tag) => void;
  onAskDelete: (tag: Tag, remote: string | null) => void;
}): ReactNode {
  const store = useStore();
  const tags = useAppState((state) => state.tags);
  const remotes = useAppState((state) => state.remotes);
  const [open, setOpen] = useState(true);
  const [menu, setMenu] = useState<TagMenuTarget | null>(null);
  const bodyId = useId();
  const root = useAppState((state) =>
    state.repo.state === 'ready' ? state.repo.value.root : null,
  );

  // A menu left open across a repository change would push a name from the old
  // one into the new one. Adjusted during render, the way this panel drops its
  // questions when the root changes.
  const [lastRoot, setLastRoot] = useState(root);
  if (root !== lastRoot) {
    setLastRoot(root);
    setMenu(null);
  }

  // Where a push would go: `origin` when there is one, else the first remote
  // — the same rule the commit menu follows, so the two cannot name different
  // remotes for the same act. The menu says which one it picked in the item's
  // own label rather than choosing silently.
  const remote = preferredRemote(remotes);

  const sectionsFor = (tag: Tag): MenuSection[] =>
    buildTagMenu(tag, { busy, remote }).map((section) =>
      section.map((menuItem) => {
        const action = menuItem.action;
        return {
          id: menuItem.id,
          label: menuItem.label,
          disabled: menuItem.disabled,
          ...(action === undefined
            ? {}
            : {
                onSelect: (): void => {
                  // No delete acts from here: both open the question this
                  // panel already asks, and the reason the user agrees to is
                  // what the git layer validates.
                  if (action.kind === 'show') onSelect(tag);
                  else if (action.kind === 'push')
                    void pushTagTo(store, action.remote, tag.name);
                  else if (action.kind === 'delete') onAskDelete(tag, null);
                  else if (action.kind === 'delete-remote')
                    onAskDelete(tag, action.remote);
                  else if (action.kind === 'copy') void copyText(action.text);
                },
              }),
        };
      }),
    );

  return (
    <section className={styles.section} aria-label="Tags">
      <CollapsibleHeader
        level="section"
        title="Tags"
        icon={<TagIcon size={13} />}
        count={tags.state === 'ready' ? tags.value.length : null}
        open={open}
        bodyId={bodyId}
        onToggle={() => setOpen((was) => !was)}
      />

      <div id={bodyId} hidden={!open}>
        {tags.state === 'idle' && (
          <Notice title="No repository open">Open a repository to see its tags.</Notice>
        )}
        {tags.state === 'loading' && (
          <Notice title="Loading tags…" live>
            Reading refs from git.
          </Notice>
        )}
        {tags.state === 'error' && (
          <Notice title="Could not read the tags" tone="error">
            {tags.message}
            {tags.kind !== undefined ? ` (${tags.kind})` : ''}
          </Notice>
        )}
        {tags.state === 'ready' &&
          (tags.value.length === 0 ? (
            <p className={styles.empty}>No tags.</p>
          ) : (
            <ul className={styles.list}>
              {tags.value.map((tag) => (
                <TagRow
                  key={tag.name}
                  tag={tag}
                  busy={busy}
                  named={selectedRef === tagRef(tag)}
                  selected={isTagSelected(tag, selectedRef, selectedOid)}
                  onSelect={onSelect}
                  onAskDelete={onAskDelete}
                  onMenu={(x, y) => setMenu({ tag, x, y })}
                />
              ))}
            </ul>
          ))}
      </div>

      {menu !== null && (
        <ContextMenu
          sections={sectionsFor(menu.tag)}
          x={menu.x}
          y={menu.y}
          label={`Actions for tag ${menu.tag.name}`}
          onClose={() => setMenu(null)}
        />
      )}
    </section>
  );
}

/** One tag: read the commit it names, or delete the name. */
function TagRow({
  tag,
  busy,
  named,
  selected,
  onSelect,
  onAskDelete,
  onMenu,
}: {
  tag: Tag;
  busy: boolean;
  /** The row the selection named, as opposed to one merely on its commit. */
  named: boolean;
  selected: boolean;
  onSelect: (tag: Tag) => void;
  onAskDelete: (tag: Tag, remote: string | null) => void;
  onMenu: (x: number, y: number) => void;
}): ReactNode {
  const ref = useRef<HTMLButtonElement>(null);

  // Same rule as a branch row: a selection arriving from a chip in the history
  // has to be visible, and only the row that was *named* moves the list.
  useEffect(() => {
    if (named) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [named]);

  return (
    <li className={styles.row}>
      <button
        ref={ref}
        type="button"
        className={`${styles.name} ${selected ? styles.nameSelected : ''}`}
        disabled={busy}
        aria-pressed={selected}
        title={`${tagSummary(tag)}\n\nShow the commit it points at. Right-click for push, delete and copy.`}
        onClick={() => onSelect(tag)}
        onContextMenu={(event) => {
          event.preventDefault();
          onMenu(event.clientX, event.clientY);
        }}
      >
        {/* Filled for an annotated tag, hollow for a lightweight one — the same
            language the branch rows use for "this is the one you are on". */}
        <span aria-hidden="true" className={`${styles.marker} ${styles.tagMarker}`}>
          {tag.annotated ? '◆' : '◇'}
        </span>
        <span className={`${styles.nameText} ${styles.nameTail}`}>
          <bdi>{tag.name}</bdi>
        </span>
      </button>
      <button
        type="button"
        className={`${styles.button} ${styles.danger}`}
        disabled={busy}
        // Named for a screen reader, fixed-width on screen, for the reason the
        // branch rows' buttons are: the name is what the row exists to show.
        aria-label={`Delete tag ${tag.name}`}
        title={`Delete tag ${tag.name}. It stays on any remote it was pushed to.`}
        onClick={() => onAskDelete(tag, null)}
      >
        Delete
      </button>
    </li>
  );
}

/**
 * The tag-delete question, for both the local delete and the remote one.
 *
 * One stage and no arming checkbox, like the remote branch delete: there is
 * nothing to escalate to, because git does not refuse either of these the way
 * it refuses an unmerged branch. What stands in the way instead is the sentence
 * saying what goes, and Cancel holding the focus, so a stray Enter deletes
 * nothing.
 */
function TagDeleteConfirmation({
  deletion,
  busy,
  onCancel,
  onConfirm,
}: {
  deletion: TagDeletion;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactNode {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { tag, remote } = deletion;

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <div
      className={styles.confirm}
      role="alertdialog"
      aria-modal="true"
      aria-label={remote === null ? 'Confirm tag delete' : 'Confirm remote tag delete'}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
        trapTab(event);
      }}
    >
      <strong className={styles.noticeTitle}>
        {remote === null
          ? deleteTagQuestion(tag.name)
          : deleteRemoteTagQuestion({ remote, tag: tag.name })}
      </strong>
      <p className={styles.noticeText}>
        {remote === null
          ? deleteTagDetail(tagRestoreCommand(tag))
          : deleteRemoteTagDetail(remote)}
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
          className={`${styles.button} ${styles.danger}`}
          disabled={busy}
          onClick={onConfirm}
        >
          {remote === null ? 'Delete Tag' : `Delete on ${remote}`}
        </button>
      </div>
    </div>
  );
}

interface StashMenuTarget {
  entry: StashEntry;
  x: number;
  y: number;
}

/**
 * The stash list.
 *
 * Two rules shape the rows. A stash is *opened* before it is acted on: the row
 * is a button that selects the stash commit, so the diff panel shows what is
 * inside it — applying or popping a stash whose contents nobody has seen is how
 * work gets overwritten by a surprise. And the actions live on a context menu
 * rather than on buttons that fade in under the pointer: those sat on top of
 * the message, they were invisible until the row was hovered, and `Drop` was a
 * few pixels from `Pop`. The menu is the one the history panel opens on a stash
 * row, built by `buildStashMenu`, so the two cannot drift into offering
 * different things.
 */
function StashesSection({
  busy,
  selectedOid,
  onAsk,
}: {
  busy: boolean;
  selectedOid: string | null;
  onAsk: (entry: StashEntry, kind: StashActionKind) => void;
}): ReactNode {
  const store = useStore();
  const stashes = useAppState((state) => state.stashes);
  const status = useAppState((state) => state.status);
  const now = new Date();
  const [open, setOpen] = useState(true);
  const [menu, setMenu] = useState<StashMenuTarget | null>(null);
  const bodyId = useId();

  const sectionsFor = (entry: StashEntry): MenuSection[] => {
    const offers = buildStashMenu(entry, {
      busy,
      hasConflicts: status.state === 'ready' && status.value.hasConflicts,
    }).map((section) =>
      section.map((item) => {
        const action = item.action;
        return {
          id: item.id,
          label: item.label,
          disabled: item.disabled,
          ...(action === undefined
            ? {}
            : {
                onSelect: (): void => {
                  // Neither branch acts on its own: a stash action opens the
                  // question this panel already asks, and the reason the user
                  // agrees to is what the git layer validates.
                  if (action.kind === 'stash') onAsk(action.entry, action.op);
                  else if (action.kind === 'copy') void copyText(action.text);
                },
              }),
        };
      }),
    );
    // First, because it is what a click on the row already does and the menu is
    // where a user looks to find out that it does it.
    return [
      [
        {
          id: 'stash-show',
          label: 'Show changes',
          disabled: null,
          onSelect: () => void selectCommit(store, entry.oid),
        },
      ],
      ...offers,
    ];
  };

  return (
    <section className={styles.section} aria-label="Stashes">
      <CollapsibleHeader
        level="section"
        title="Stashes"
        icon={<StashIcon size={13} />}
        count={stashes.state === 'ready' ? stashes.value.length : null}
        open={open}
        bodyId={bodyId}
        onToggle={() => setOpen((was) => !was)}
      />

      <div id={bodyId} hidden={!open}>
        {stashes.state === 'idle' && (
          <Notice title="No repository open">
            Open a repository to see its stashes.
          </Notice>
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
                  <button
                    type="button"
                    className={`${styles.stashButton} ${
                      selectedOid === entry.oid ? styles.stashSelected : ''
                    }`}
                    aria-current={selectedOid === entry.oid ? 'true' : undefined}
                    // The whole message, because the row shows one clipped line
                    // of it. The context-menu key fires the same handler as a
                    // right-click, so the actions are reachable from here too.
                    title={`${stashLabel(entry)}\n\nShow what ${entry.ref} changed. Right-click for apply, pop and delete.`}
                    onClick={() => void selectCommit(store, entry.oid)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setMenu({ entry, x: event.clientX, y: event.clientY });
                    }}
                  >
                    <span className={styles.stashMessage}>{stashLabel(entry)}</span>
                    <span className={styles.stashMeta}>
                      <span className={styles.stashRef}>{entry.ref}</span>
                      {entry.branch !== undefined && <span>on {entry.branch}</span>}
                      <time dateTime={entry.date} title={entry.date}>
                        {formatRelativeDate(entry.date, now)}
                      </time>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ))}
      </div>

      {menu !== null && (
        <ContextMenu
          sections={sectionsFor(menu.entry)}
          x={menu.x}
          y={menu.y}
          label={`Actions for stash ${menu.entry.ref}`}
          onClose={() => setMenu(null)}
        />
      )}
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
        trapTab(event);
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
