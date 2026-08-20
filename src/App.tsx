import { useEffect, type ReactNode } from 'react';
import './index.css';
import './app.css';
import { loadConfig } from './config/store';
import { closeRepo } from './state/actions';
import { useAppState, useStore } from './state/hooks';
import { watchRepository, type WatchHandle } from './state/watch';
import { DiffView } from './views/diff';
import { HistoryView } from './views/history/HistoryView';
import { WelcomeView } from './views/welcome';

export const APP_NAME = 'Krakenless';

/** Loads saved settings once, on startup. */
function useLoadedConfig(): void {
  const store = useStore();
  useEffect(() => {
    let cancelled = false;
    void loadConfig().then((config) => {
      if (!cancelled) store.dispatch({ type: 'config/loaded', config });
    });
    return () => {
      cancelled = true;
    };
  }, [store]);
}

/**
 * Watches the open repository for as long as it stays open. Re-runs when the
 * root changes so the watcher never points at a repository the user has left.
 */
function useRepositoryWatch(root: string | null): void {
  const store = useStore();
  useEffect(() => {
    if (root === null) return;
    let handle: WatchHandle | null = null;
    let stopped = false;

    void watchRepository(store, root).then((started) => {
      // The repository may have been closed while the watcher was starting.
      if (stopped) {
        void started.stop();
        return;
      }
      handle = started;
    });

    return () => {
      stopped = true;
      void handle?.stop();
    };
  }, [store, root]);
}

function RepoHeader({ root }: { root: string }): ReactNode {
  const store = useStore();
  const status = useAppState((state) => state.status);
  const name = root.split('/').filter(Boolean).pop() ?? root;

  return (
    <header className="repo-header">
      <div className="repo-header__identity">
        <span className="repo-header__name">{name}</span>
        <span className="repo-header__path" title={root}>
          {root}
        </span>
      </div>
      <div className="repo-header__branch">
        {status.state === 'ready' && (
          <>
            <span>
              {status.value.detached ? 'detached HEAD' : (status.value.branch ?? '—')}
            </span>
            {status.value.ahead > 0 && <span title="ahead">↑{status.value.ahead}</span>}
            {status.value.behind > 0 && (
              <span title="behind">↓{status.value.behind}</span>
            )}
            {status.value.hasConflicts && (
              <span className="repo-header__conflicts">conflicts</span>
            )}
          </>
        )}
        {status.state === 'loading' && <span>reading status…</span>}
        {status.state === 'error' && (
          <span className="repo-header__conflicts" title={status.message}>
            status unavailable
          </span>
        )}
      </div>
      <button
        type="button"
        className="repo-header__close"
        onClick={() => closeRepo(store)}
      >
        Close repository
      </button>
    </header>
  );
}

function RepoView({ root }: { root: string }): ReactNode {
  useRepositoryWatch(root);

  return (
    <div className="repo-layout">
      <RepoHeader root={root} />
      <div className="repo-panels">
        <section className="repo-panels__history" aria-label="History">
          <HistoryView />
        </section>
        <section className="repo-panels__diff" aria-label="Changes">
          <DiffView />
        </section>
      </div>
    </div>
  );
}

export default function App(): ReactNode {
  useLoadedConfig();
  const repo = useAppState((state) => state.repo);

  if (repo.state === 'ready') {
    return <RepoView root={repo.value.root} />;
  }
  return <WelcomeView />;
}
