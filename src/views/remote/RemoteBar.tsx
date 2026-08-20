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
import styles from './RemoteBar.module.css';
import {
  candidateRemotes,
  fetchBlock,
  pullBlock,
  pushBlock,
  readUpstream,
  summarize,
  type Gate,
} from './remotes';

type ActionKind = 'fetch' | 'pull' | 'push' | 'publish';

interface Outcome {
  kind: ActionKind;
  ok: boolean;
}

const RUNNING_LABEL: Record<ActionKind, string> = {
  fetch: 'Fetching…',
  pull: 'Pulling…',
  push: 'Pushing…',
  publish: 'Publishing the branch…',
};

const SUCCESS_LABEL: Record<ActionKind, string> = {
  fetch: 'Fetch finished. The counts below were re-read afterwards.',
  pull: 'Pull finished. Your branch was fast-forwarded onto its upstream.',
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
  const busy = useAppState((state) => state.busy);

  const [running, setRunning] = useState<ActionKind | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [chosenRemote, setChosenRemote] = useState<string | null>(null);

  const repoOpen = repo.state === 'ready';
  const upstream = readUpstream(status);
  const remotes = candidateRemotes(branches);
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
    publishRemote,
  };

  const publishing = upstream.kind === 'no-upstream';

  const run = async (kind: ActionKind, act: () => Promise<boolean>): Promise<void> => {
    setRunning(kind);
    setOutcome(null);
    try {
      // `false` means the action layer caught a GitError and dispatched a
      // notice. It is a failure, and it is recorded as one.
      setOutcome({ kind, ok: await act() });
    } catch {
      // The action layer is not supposed to throw; if it does, the operation
      // still did not finish, and saying so is the only honest option.
      setOutcome({ kind, ok: false });
    } finally {
      setRunning(null);
    }
  };

  const onPush = (): void => {
    if (upstream.kind === 'no-upstream') {
      if (publishRemote === null) return;
      void run('publish', () =>
        pushCurrent(store, {
          remote: publishRemote,
          branch: upstream.branch,
          setUpstream: true,
        }),
      );
      return;
    }
    if (upstream.kind !== 'tracking') return;
    void run('push', () =>
      pushCurrent(store, {
        remote: upstream.upstream.remote,
        branch: upstream.branch,
      }),
    );
  };

  const summary = summarize(status);
  const pushReason = pushBlock(gate);

  return (
    <section className={styles.bar} aria-label="Remote">
      <div className={styles.tracking}>
        <strong className={styles.headline}>{summary.headline}</strong>
        <span className={styles.detail}>{summary.detail}</span>
      </div>

      <div className={styles.actions}>
        <Action
          id="remote-fetch"
          label="Fetch"
          reason={fetchBlock(gate)}
          hint="Downloads new commits from every remote and prunes branches that are gone. Nothing in your working tree changes."
          onClick={() => void run('fetch', () => fetchRemote(store))}
        />
        <Action
          id="remote-pull"
          label="Pull"
          reason={pullBlock(gate)}
          hint="Fast-forward only. If your branch and its upstream have diverged, git stops and says so instead of merging for you."
          onClick={() => void run('pull', () => pullCurrent(store))}
        />
        <Action
          id="remote-push"
          label={publishing ? 'Publish branch' : 'Push'}
          reason={pushReason}
          hint={pushHint(upstream, publishRemote)}
          onClick={onPush}
        />

        {publishing && remotes.length > 1 && (
          <div className={styles.remotePicker}>
            <label className={styles.remoteLabel} htmlFor="remote-target">
              Publish to
            </label>
            <select
              id="remote-target"
              className={styles.select}
              value={publishRemote ?? ''}
              disabled={busy}
              onChange={(event) => setChosenRemote(event.target.value)}
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

      {running !== null && (
        <p className={styles.progress} role="status">
          {RUNNING_LABEL[running]}
        </p>
      )}

      {running === null && outcome !== null && (
        <p
          className={outcome.ok ? styles.success : styles.failure}
          role={outcome.ok ? 'status' : 'alert'}
        >
          {outcome.ok
            ? SUCCESS_LABEL[outcome.kind]
            : `${FAILURE_LABEL[outcome.kind]} Krakenless is showing what git reported; read that message before trying again.`}
        </p>
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
      : `Creates ${publishRemote}/${upstream.branch} and sets it as this branch's upstream.`;
  }
  if (upstream.kind === 'tracking') {
    const { remote, branch } = upstream.upstream;
    return `Sends your commits to ${remote}/${branch}. Krakenless never force-pushes: if the remote has moved, git refuses and nothing is overwritten.`;
  }
  return 'Krakenless never force-pushes; a rejected push leaves the remote untouched.';
}

/** One button plus, when it is off, the reason in text the user can read. */
function Action({
  id,
  label,
  reason,
  hint,
  onClick,
}: {
  id: string;
  label: string;
  reason: string | null;
  hint: string;
  onClick: () => void;
}): ReactNode {
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
        {label}
      </button>
      {reason === null ? (
        <span id={hintId} className={styles.hint}>
          {hint}
        </span>
      ) : (
        <span id={reasonId} className={styles.reason}>
          {reason}
        </span>
      )}
    </div>
  );
}
