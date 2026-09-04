/**
 * Remote toolbar: fetch, pull, push, and the branch's relationship to its
 * upstream.
 *
 * Three rules shape this file. Nothing here reports success it did not
 * observe: the action layer returns `false` and dispatches a notice when git
 * refuses, so a `false` becomes a failure line — never a silent no-op and
 * never a "Pulled." The error text itself is not repeated, because the shell
 * already renders the notice and two differently-worded copies of one failure
 * is how a user ends up trusting the wrong one. Every disabled button states
 * its reason in visible text next to it, since a disabled control cannot be
 * focused and its tooltip is never announced. And force push is deliberately
 * absent: the git layer refuses it without a confirmation token minted from a
 * dialog that does not exist yet, so offering the button would only produce an
 * error the user cannot act on.
 */

import { useEffect, useState, type ReactNode } from 'react';
import {
  fetchRemote,
  pullCurrent,
  pullMergeCurrent,
  pushCurrent,
  refreshBranches,
} from '../../state/actions';
import { useAppState, useStore } from '../../state/hooks';
import { isBusy } from '../../state/store';
import { DialogHost, type ConfirmDialog } from '../history/CommitActions';
import { CheckIcon, FetchIcon, PullIcon, PushIcon, SpinnerIcon } from '../shell/icons';
import styles from './RemoteBar.module.css';
import {
  BUSY_REASON,
  candidateRemotes,
  divergence,
  fetchBlock,
  pullBlock,
  pullMergeQuestion,
  pushBlock,
  pushIntent,
  readUpstream,
  summarize,
  type Gate,
} from './remotes';

type ActionKind = 'fetch' | 'pull' | 'pull-merge' | 'push' | 'publish';

/** The running line, which a blocked button points at while it is on screen. */
const PROGRESS_ID = 'remote-progress';

interface Outcome {
  kind: ActionKind;
  ok: boolean;
  /**
   * Where the operation ran. An outcome is only shown while the panel is still
   * describing that repository and that branch — "Push finished." sitting under
   * another branch's counts reads as a claim about the branch on screen.
   */
  repoRoot: string | null;
  branch: string | null;
}

const RUNNING_LABEL: Record<ActionKind, string> = {
  fetch: 'Fetching…',
  pull: 'Pulling…',
  'pull-merge': 'Pulling and merging…',
  push: 'Pushing…',
  publish: 'Publishing the branch…',
};

const SUCCESS_LABEL: Record<ActionKind, string> = {
  fetch: 'Fetch finished. The counts below were re-read afterwards.',
  // Not "fast-forwarded": `pull --ff-only` also succeeds with nothing to do.
  pull: 'Pull finished. Fast-forward only, so nothing was merged on your behalf.',
  'pull-merge': 'Pull finished. The upstream was merged into your branch.',
  push: 'Push finished.',
  publish: 'Branch published and set as the upstream.',
};

const FAILURE_LABEL: Record<ActionKind, string> = {
  fetch: 'Fetch did not complete.',
  pull: 'Pull did not complete, and your branch was left as it was.',
  // No claim about the branch's state: a merge can resolve cleanly and then
  // fail at the commit (a signing key, a hook), leaving a merge in progress
  // that the operation panel reports.
  'pull-merge': 'Pull did not complete.',
  push: 'Push did not complete. Nothing was published.',
  publish: 'Publishing did not complete. The branch still has no upstream.',
};

/** The remote toolbar. Reads the store, acts only through the action layer. */
export function RemoteBar(): ReactNode {
  const store = useStore();
  const repo = useAppState((state) => state.repo);
  const status = useAppState((state) => state.status);
  const branches = useAppState((state) => state.branches);
  const remoteList = useAppState((state) => state.remotes);
  const busy = useAppState(isBusy);

  const [running, setRunning] = useState<ActionKind | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // The merge-pull question, while it is on screen. Kept as dialog state (not
  // derived) so a background refresh that changes the counts mid-question
  // cannot swap the sentence the user is about to agree to.
  const [dialog, setDialog] = useState<ConfirmDialog | null>(null);
  // The pick is stored with the repository it was made in: two repositories
  // can both have a remote called `origin` and mean different servers, so a
  // choice must never carry over. Kept as state rather than reset in an
  // effect, so no render ever sees the previous repository's target.
  const [choice, setChoice] = useState<{
    repoRoot: string | null;
    remote: string;
  } | null>(null);

  const repoOpen = repo.state === 'ready';
  const repoRoot = repo.state === 'ready' ? repo.value.root : null;
  const upstream = readUpstream(status);
  const branchNow = 'branch' in upstream ? upstream.branch : null;
  // `git remote` first, branch-derived names only as a fallback: a remote that
  // has never been fetched from has no tracking refs to derive a name from.
  const remotes = candidateRemotes(branches, remoteList);
  const chosenRemote =
    choice !== null && choice.repoRoot === repoRoot ? choice.remote : null;
  // A chosen remote that has vanished from the list (the branch list was
  // re-read, the remote was removed) must not survive as a push target.
  const publishRemote =
    chosenRemote !== null && remotes.includes(chosenRemote)
      ? chosenRemote
      : (remotes[0] ?? null);

  // The branch list is what remote names are recovered from, and opening a
  // repository does not load it. Without this the publish flow would be dead
  // until some other panel happened to refresh.
  useEffect(() => {
    if (repoOpen && branches.state === 'idle') void refreshBranches(store);
  }, [store, repoOpen, branches.state]);

  const gate: Gate = {
    repoOpen,
    busy,
    statusState: status.state,
    hasConflicts: status.state === 'ready' && status.value.hasConflicts,
    upstream,
    branchesState: branches.state,
    publishRemote,
  };

  const publishing = upstream.kind === 'no-upstream';

  const run = async (kind: ActionKind, act: () => Promise<boolean>): Promise<void> => {
    setRunning(kind);
    setOutcome(null);
    try {
      // `false` means the action layer caught a GitError and dispatched a
      // notice. It is a failure, and it is recorded as one.
      setOutcome({ kind, ok: await act(), repoRoot, branch: branchNow });
    } catch {
      // The action layer is not supposed to throw; if it does, the operation
      // still did not finish, and saying so is the only honest option.
      setOutcome({ kind, ok: false, repoRoot, branch: branchNow });
    } finally {
      setRunning(null);
    }
  };

  // The one action whose outcome has three honest answers, not two. A
  // conflicted stop sets no outcome line at all: the warning notice and the
  // conflict banner already narrate it, and a third copy is the two-copies
  // failure mode this file's header forbids.
  const runMergePull = async (reason: string): Promise<void> => {
    setRunning('pull-merge');
    setOutcome(null);
    try {
      const result = await pullMergeCurrent(store, reason);
      if (result !== 'conflicted') {
        setOutcome({
          kind: 'pull-merge',
          ok: result === 'pulled',
          repoRoot,
          branch: branchNow,
        });
      }
    } catch {
      setOutcome({ kind: 'pull-merge', ok: false, repoRoot, branch: branchNow });
    } finally {
      setRunning(null);
    }
  };

  const diverged = divergence(upstream);
  const onPull = (): void => {
    if (diverged !== null && upstream.kind === 'tracking') {
      setDialog({
        kind: 'confirm',
        title: `Merge ${upstream.upstream.remote}/${upstream.upstream.branch} into ${upstream.branch}?`,
        question: pullMergeQuestion(upstream.branch, upstream.upstream, diverged),
        confirmLabel: 'Pull and merge',
        // Not danger, for the reason the merge dialog is not: a merge adds
        // commits and rewrites none.
        danger: false,
        run: (reason) => runMergePull(reason),
      });
      return;
    }
    void run('pull', () => pullCurrent(store));
  };

  const onPush = (): void => {
    // Derived from the gate, not from the button's `disabled` attribute: the
    // refusals encoded there are what keep a push off a branch the user was
    // never shown, and they must not depend on how the control rendered.
    const intent = pushIntent(gate);
    if (intent === null) return;
    void run(intent.setUpstream === true ? 'publish' : 'push', () =>
      pushCurrent(store, intent),
    );
  };

  const summary = summarize(status);
  const pushReason = pushBlock(gate);
  // A status that is mid-refresh keeps the outcome on screen: it is the same
  // branch being re-read, usually by the refresh this very operation triggered.
  const outcomeApplies =
    outcome !== null &&
    outcome.repoRoot === repoRoot &&
    (status.state !== 'ready' || outcome.branch === branchNow);

  // Built once and rendered twice: the buttons in the toolbar row, and the
  // reasons in the strip below it. A blocked action must state its reason in
  // text, because a disabled control cannot be focused and its tooltip is
  // never announced — the strip is where that text lives now that the buttons
  // are compact.
  // The icon becomes a spinner while that action runs: the answer to "is it
  // doing anything?" belongs on the control that was pressed.
  const spinning = (kind: ActionKind, icon: ReactNode): ReactNode =>
    running === kind ? <SpinnerIcon className={styles.spinner} /> : icon;
  // The button that just succeeded turns green for as long as its outcome
  // line is on screen — the same condition, so the two never disagree.
  const finished = (...kinds: ActionKind[]): boolean =>
    running === null &&
    outcome !== null &&
    outcome.ok &&
    outcomeApplies &&
    kinds.includes(outcome.kind);

  const actions: ToolbarAction[] = [
    {
      id: 'remote-fetch',
      label: 'Fetch',
      icon: spinning('fetch', <FetchIcon />),
      reason: fetchBlock(gate),
      hint: 'Downloads new commits from every remote and prunes branches that are gone. Nothing in your working tree changes.',
      done: finished('fetch'),
      onClick: () => void run('fetch', () => fetchRemote(store)),
    },
    {
      id: 'remote-pull',
      // The label changes with what the click will actually do: a diverged
      // branch cannot fast-forward, so the button says the merge is coming
      // and the click asks before running it.
      label: diverged === null ? 'Pull' : 'Pull (merge)',
      icon: spinning(diverged === null ? 'pull' : 'pull-merge', <PullIcon />),
      reason: pullBlock(gate),
      hint:
        diverged === null
          ? 'Fast-forward only. If your branch and its upstream have diverged, git stops and says so instead of merging for you.'
          : 'Your branch and its upstream have diverged. This asks for confirmation, then fetches and merges the upstream into your branch.',
      done: finished('pull', 'pull-merge'),
      onClick: onPull,
    },
    {
      id: 'remote-push',
      label: publishing ? 'Publish branch' : 'Push',
      icon: spinning(publishing ? 'publish' : 'push', <PushIcon />),
      reason: pushReason,
      hint: pushHint(upstream, publishRemote),
      done: finished('push', 'publish'),
      onClick: onPush,
    },
  ];

  /**
   * The reasons to draw, and which line each button points at.
   *
   * Every gate answers "something else is running" before it answers anything
   * else, so while one command is in flight all three actions carry the *same*
   * sentence — and the strip used to print it once per button. One line per
   * distinct sentence; the buttons that share it share its id.
   */
  const reasonLines: { id: string; text: string }[] = [];
  const reasonIds = new Map<string, string>();
  for (const action of actions) {
    if (action.reason === null) continue;
    const shared = reasonLines.find((line) => line.text === action.reason);
    if (shared !== undefined) {
      reasonIds.set(action.id, shared.id);
      continue;
    }
    const id = `${action.id}-reason`;
    reasonLines.push({ id, text: action.reason });
    reasonIds.set(action.id, id);
  }

  // While *this* toolbar is the thing that is busy, "another git operation is
  // already running" is a worse way of saying "Pushing…", which is on screen
  // right below it. The progress line speaks for the buttons instead.
  const showReasons = running === null;
  const describe = (action: ToolbarAction): string | null =>
    action.reason === null
      ? null
      : showReasons
        ? (reasonIds.get(action.id) ?? null)
        : PROGRESS_ID;

  const strip =
    (showReasons && reasonLines.length > 0) ||
    running !== null ||
    (outcome !== null && outcomeApplies) ? (
      <div className={styles.messages}>
        {showReasons &&
          reasonLines.map((line) => (
            <p
              key={line.id}
              id={line.id}
              // A wait is not a failure. Only the reasons the user has to do
              // something about are drawn in the danger colour.
              className={line.text === BUSY_REASON ? styles.waiting : styles.reason}
            >
              {line.text}
            </p>
          ))}

        {running !== null && (
          <p className={styles.progress} id={PROGRESS_ID} role="status">
            {RUNNING_LABEL[running]}
          </p>
        )}

        {running === null && outcome !== null && outcomeApplies && (
          <p
            className={outcome.ok ? styles.success : styles.failure}
            role={outcome.ok ? 'status' : 'alert'}
          >
            {outcome.ok && <CheckIcon size={12} className={styles.successIcon} />}
            {outcome.ok
              ? SUCCESS_LABEL[outcome.kind]
              : `${FAILURE_LABEL[outcome.kind]} Krakenless is showing what git reported; read that message before trying again.`}
          </p>
        )}
      </div>
    ) : null;

  return (
    <section className={styles.bar} aria-label="Remote">
      <div className={styles.row}>
        {/*
          The buttons and the words about them are one column, so a reason or an
          outcome is centred under the control it is about instead of running
          along the left edge of the bar, where it reads as being about the
          repository name it happens to sit under.
        */}
        <div className={styles.column}>
          <div className={styles.actions}>
            {actions.map((action) => (
              <Action key={action.id} {...action} reasonId={describe(action)} />
            ))}

            {/*
              Shown for a single candidate too: the remote set here is
              reconstructed from the branch list, so a repository can have
              remotes Krakenless has never seen. Publishing to a silent default
              would push a new branch to a remote the user was never offered.
            */}
            {publishing && remotes.length > 0 && (
              <div className={styles.remotePicker}>
                <label className={styles.remoteLabel} htmlFor="remote-target">
                  Publish to
                </label>
                <select
                  id="remote-target"
                  className={styles.select}
                  value={publishRemote ?? ''}
                  disabled={busy}
                  onChange={(event) =>
                    setChoice({ repoRoot, remote: event.target.value })
                  }
                >
                  {remotes.map((remote) => (
                    <option key={remote} value={remote}>
                      {remote}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {strip}
        </div>

        <div className={styles.tracking}>
          <strong className={styles.headline}>{summary.headline}</strong>
          <span className={styles.detail}>{summary.detail}</span>
        </div>
      </div>

      {dialog !== null && (
        <DialogHost dialog={dialog} onClose={() => setDialog(null)} busy={busy} />
      )}
    </section>
  );
}

/** What push will actually do, spelled out before it is clicked. */
function pushHint(
  upstream: ReturnType<typeof readUpstream>,
  publishRemote: string | null,
): string {
  if (upstream.kind === 'no-upstream') {
    return publishRemote === null
      ? 'Publishing creates the branch on a remote and starts tracking it.'
      : `Pushes ${upstream.branch} to ${publishRemote} and sets ${publishRemote}/${upstream.branch} as its upstream. If that branch already exists on the remote, git updates it or refuses — it is never overwritten.`;
  }
  if (upstream.kind === 'tracking') {
    const { remote, branch } = upstream.upstream;
    return `Sends your commits to ${remote}/${branch}. Krakenless never force-pushes: if the remote has moved, git refuses and nothing is overwritten.`;
  }
  return 'Krakenless never force-pushes; a rejected push leaves the remote untouched.';
}

/** One toolbar action: the icon button, and the words that describe it. */
interface ToolbarAction {
  id: string;
  label: string;
  icon: ReactNode;
  /** Non-null when the action is unavailable; the text says why. */
  reason: string | null;
  hint: string;
  /**
   * True right after this action succeeded: the button turns green and says
   * so, until the next click or the next refresh of the branch. A push that
   * worked used to be one grey line under the toolbar, which is the same
   * weight the app gives "nothing happened".
   */
  done?: boolean;
  onClick: () => void;
}

/**
 * The button itself. An enabled button is described by its hint, which is read
 * out but not drawn — the toolbar has no room for a sentence per control. A
 * blocked one points at the line in the strip below the toolbar that explains
 * it, which several buttons may share: `reasonId` is that line, chosen by the
 * toolbar, because the strip prints one copy of a sentence however many
 * buttons it refuses.
 */
function Action({
  id,
  label,
  icon,
  reason,
  hint,
  reasonId,
  done = false,
  onClick,
}: ToolbarAction & { reasonId: string | null }): ReactNode {
  const hintId = `${id}-hint`;

  return (
    <div className={styles.action}>
      <button
        type="button"
        className={done ? `${styles.button} ${styles.buttonDone}` : styles.button}
        disabled={reason !== null}
        aria-describedby={reasonId ?? hintId}
        // Announced, not only coloured: the green is the feedback for eyes, the
        // attribute is the same feedback for a screen reader.
        data-done={done ? 'true' : undefined}
        onClick={onClick}
      >
        {done ? <CheckIcon className={styles.check} /> : icon}
        <span>{label}</span>
      </button>
      {reason === null && (
        <span id={hintId} className={styles.srOnly}>
          {hint}
        </span>
      )}
    </div>
  );
}
