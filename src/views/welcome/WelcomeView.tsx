/**
 * The first screen: pick a folder, or reopen a recent repository.
 *
 * Thin by design — it reads the store and calls the action layer, never the
 * git layer. Everything it can fail at (no git, wrong folder, a cancelled
 * picker) has its own honest wording in `messages.ts`.
 */

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { forgetRepo, openRepo } from '../../state/actions';
import { useAppState, useStore } from '../../state/hooks';
import { formatLastOpened, repoErrorMessage, repoName } from './messages';
import styles from './WelcomeView.module.css';

export function WelcomeView(): ReactNode {
  const store = useStore();
  const repo = useAppState((state) => state.repo);
  const recentRepos = useAppState((state) => state.config.recentRepos);
  const [pickerError, setPickerError] = useState<string | null>(null);
  // Labels are computed when the list changes, so the clock is read there and
  // never during an arbitrary render.
  const rows = useMemo(() => {
    const now = new Date();
    return recentRepos.map((recent) => ({
      path: recent.path,
      name: repoName(recent.path),
      when: formatLastOpened(recent.lastOpened, now),
    }));
  }, [recentRepos]);

  const primaryRef = useRef<HTMLButtonElement>(null);

  const opening = repo.state === 'loading';

  /** Forgetting the last row removes the focused element; keep focus on screen. */
  const forget = (path: string): void => {
    if (recentRepos.length === 1) primaryRef.current?.focus();
    void forgetRepo(store, path);
  };

  const pickFolder = useCallback(async (): Promise<void> => {
    setPickerError(null);
    let picked: string | string[] | null;
    try {
      picked = await open({ directory: true, multiple: false });
    } catch (error) {
      setPickerError(error instanceof Error ? error.message : String(error));
      return;
    }
    // A cancelled dialog resolves to null and is simply nothing happening.
    if (typeof picked !== 'string') return;
    await openRepo(store, picked);
  }, [store]);

  return (
    <main className={styles.welcome}>
      <header className={styles.header}>
        <h1 className={styles.title}>Krakenless</h1>
        <p className={styles.tagline}>
          A fast, private Git client. No account. No telemetry.
        </p>
      </header>

      <button
        type="button"
        className={styles.primary}
        ref={primaryRef}
        onClick={() => void pickFolder()}
        disabled={opening}
      >
        Open a repository…
      </button>

      {opening ? (
        <p className={styles.status} role="status">
          Opening repository…
        </p>
      ) : null}

      {pickerError !== null ? (
        <p className={styles.error} role="alert">
          The folder picker could not be opened. {pickerError}
        </p>
      ) : null}

      {repo.state === 'error' ? (
        <RepoError message={repo.message} kind={repo.kind} onPickAnother={pickFolder} />
      ) : null}

      <section className={styles.recents} aria-labelledby="welcome-recents">
        <h2 className={styles.sectionTitle} id="welcome-recents">
          Recent repositories
        </h2>
        {rows.length === 0 ? (
          <p className={styles.empty}>
            No recent repositories yet. Open a folder to get started.
          </p>
        ) : (
          <ul className={styles.list}>
            {rows.map((recent) => (
              <li className={styles.row} key={recent.path}>
                <button
                  type="button"
                  className={styles.rowOpen}
                  onClick={() => {
                    // A stale picker failure must not survive the next action.
                    setPickerError(null);
                    void openRepo(store, recent.path);
                  }}
                  disabled={opening}
                >
                  <span className={styles.rowName}>{recent.name}</span>
                  <span className={styles.rowPath}>{recent.path}</span>
                  <span className={styles.rowWhen}>{recent.when}</span>
                </button>
                <button
                  type="button"
                  className={styles.rowForget}
                  aria-label={`Forget ${recent.path}`}
                  onClick={() => forget(recent.path)}
                >
                  Forget
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function RepoError({
  message,
  kind,
  onPickAnother,
}: {
  message: string;
  kind: string | undefined;
  onPickAnother: () => Promise<void>;
}): ReactNode {
  const { title, hint, canPickAnother } = repoErrorMessage(kind);
  return (
    <div className={styles.error} role="alert">
      <p className={styles.errorTitle}>{title}</p>
      <p className={styles.errorHint}>{hint}</p>
      <p className={styles.errorDetail}>Git said: {message}</p>
      {canPickAnother ? (
        <button
          type="button"
          className={styles.secondary}
          onClick={() => void onPickAnother()}
        >
          Choose another folder
        </button>
      ) : null}
    </div>
  );
}
