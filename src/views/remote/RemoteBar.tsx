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
  pushCurrent,
  refreshBranches,
} from '../../state/actions';
import { useAppState, useStore } from '../../state/hooks';
import { isBusy } from '../../state/store';
import { FetchIcon, PullIcon, PushIcon, SpinnerIcon } from '../shell/icons';
import styles from './RemoteBar.module.css';
import {
  candidateRemotes,
  fetchBlock,
  pullBlock,
  pushBlock,
  pushIntent,
  readUpstream,
  summarize,
  type Gate,
} from './remotes';

type ActionKind = 'fetch' | 'pull' | 'push' | 'publish';

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
  push: 'Pushing…',
  publish: 'Publishing the branch…',
};

const SUCCESS_LABEL: Record<ActionKind, string> = {
  fetch: 'Fetch finished. The counts below were re-read afterwards.',
  // Not "fast-forwarded": `pull --ff-only` also succeeds with nothing to do.
  pull: 'Pull finished. Fast-forward only, so nothing was merged on your behalf.',
  push: 'Push finished.',
  publish: 'Branch published and set as the upstream.',
};

const FAILURE_LABEL: Record<ActionKind, string> = {
  fetch: 'Fetch did not complete.',
  pull: 'Pull did not complete, and your branch was left as it was.',
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

  const actions: ToolbarAction[] = [
    {
      id: 'remote-fetch',
      label: 'Fetch',
      icon: spinning('fetch', <FetchIcon />),
      reason: fetchBlock(gate),
      hint: 'Downloads new commits from every remote and prunes branches that are gone. Nothing in your working tree changes.',
      onClick: () => void run('fetch', () => fetchRemote(store)),
    },
    {
      id: 'remote-pull',
      label: 'Pull',
      icon: spinning('pull', <PullIcon />),
      reason: pullBlock(gate),
      hint: 'Fast-forward only. If your branch and its upstream have diverged, git stops and says so instead of merging for you.',
      onClick: () => void run('pull', () => pullCurrent(store)),
    },
    {
      id: 'remote-push',
      label: publishing ? 'Publish branch' : 'Push',
      icon: spinning(publishing ? 'publish' : 'push', <PushIcon />),
      reason: pushReason,
      hint: pushHint(upstream, publishRemote),
      onClick: onPush,
    },
  ];

  const blocked = actions.filter((action) => action.reason !== null);

  return (
    <section className={styles.bar} aria-label="Remote">
      <div className={styles.row}>
        <div className={styles.actions}>
          {actions.map((action) => (
            <Action key={action.id} {...action} />
          ))}

          {/*
            Shown for a single candidate too: the remote set here is
            reconstructed from the branch list, so a repository can have remotes
            Krakenless has never seen. Publishing to a silent default would push
            a new branch to a remote the user was never offered.
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
                onChange={(event) => setChoice({ repoRoot, remote: event.target.value })}
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

        <div className={styles.tracking}>
          <strong className={styles.headline}>{summary.headline}</strong>
          <span className={styles.detail}>{summary.detail}</span>
        </div>
      </div>

      {(blocked.length > 0 ||
        running !== null ||
        (outcome !== null && outcomeApplies)) && (
        <div className={styles.messages}>
          {blocked.map((action) => (
            <p key={action.id} id={`${action.id}-reason`} className={styles.reason}>
              {action.reason}
            </p>
          ))}

          {running !== null && (
            <p className={styles.progress} role="status">
              {RUNNING_LABEL[running]}
            </p>
          )}

          {running === null && outcome !== null && outcomeApplies && (
            <p
              className={outcome.ok ? styles.success : styles.failure}
              role={outcome.ok ? 'status' : 'alert'}
            >
              {outcome.ok
                ? SUCCESS_LABEL[outcome.kind]
                : `${FAILURE_LABEL[outcome.kind]} Krakenless is showing what git reported; read that message before trying again.`}
            </p>
          )}
        </div>
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
  onClick: () => void;
}

/**
 * The button itself. An enabled button is described by its hint, which is read
 * out but not drawn — the toolbar has no room for a sentence per control. A
 * blocked one points at the reason rendered in the strip below the toolbar,
 * where it is visible to everyone.
 */
function Action({ id, label, icon, reason, hint, onClick }: ToolbarAction): ReactNode {
  const reasonId = `${id}-reason`;
  const hintId = `${id}-hint`;

  return (
    <div className={styles.action}>
      <button
        type="button"
        className={styles.button}
        disabled={reason !== null}
        aria-describedby={reason !== null ? reasonId : hintId}
        onClick={onClick}
      >
        {icon}
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
