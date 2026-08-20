import { useEffect, useState, type ReactNode } from 'react';
import './index.css';
import './app.css';
import { loadConfig } from './config/store';
import { closeRepo, refreshAllPanels } from './state/actions';
import { useAppState, useStore } from './state/hooks';
import { watchRepository, type WatchHandle } from './state/watch';
import { ChangesView } from './views/changes';
import { ConflictBanner } from './views/conflicts';
import { DiffView } from './views/diff';
import { SettingsView } from './views/settings';
import { RefsView } from './views/refs';
import { resolveShortcut } from './views/shell/shortcuts';
import { RemoteBar } from './views/remote';
import { NoticeBar } from './views/shell';
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

function RepoHeader({
  root,
  onOpenSettings,
}: {
  root: string;
  onOpenSettings: () => void;
}): ReactNode {
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
      <button type="button" className="repo-header__action" onClick={onOpenSettings}>
        Settings
      </button>
      <button
        type="button"
        className="repo-header__action"
        onClick={() => closeRepo(store)}
      >
        Close repository
      </button>
    </header>
  );
}

/** True when the event came from somewhere the user is typing. */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Moves focus into a panel by its accessible name.
 *
 * Focus goes to the panel's first focusable control rather than the container,
 * so the next Tab continues from somewhere sensible instead of restarting. The
 * panels carry `tabIndex={-1}` as the fallback: a `<section>` cannot take
 * programmatic focus without it, so an empty panel would silently swallow the
 * shortcut.
 */
function focusPanel(label: string): void {
  const panel = document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (panel === null) return;
  const focusable = panel.querySelector<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  (focusable ?? panel).focus();
}

const PANEL_LABEL: Record<string, string> = {
  'focus-history': 'History',
  'focus-refs': 'Branches and stashes',
  'focus-changes': 'Working tree',
  'focus-diff': 'Diff',
};

function RepoView({ root }: { root: string }): ReactNode {
  useRepositoryWatch(root);
  const store = useStore();
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const shortcut = resolveShortcut(event, { editable: isEditable(event.target) });
      if (shortcut === null) return;

      const panel = PANEL_LABEL[shortcut];
      if (panel !== undefined) {
        event.preventDefault();
        focusPanel(panel);
        return;
      }
      if (shortcut === 'refresh') {
        event.preventDefault();
        void refreshAllPanels(store);
        return;
      }
      if (shortcut === 'settings') {
        event.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (shortcut === 'close-repo') {
        event.preventDefault();
        closeRepo(store);
      }
      // `commit` is handled by the changes panel, which owns the draft.
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [store]);

  if (settingsOpen) {
    return <SettingsView onClose={() => setSettingsOpen(false)} />;
  }

  return (
    <div className="repo-layout">
      <RepoHeader root={root} onOpenSettings={() => setSettingsOpen(true)} />
      <RemoteBar />
      <ConflictBanner />
      <NoticeBar />
      <div className="repo-panels">
        <section className="repo-panels__history" aria-label="History" tabIndex={-1}>
          <HistoryView />
        </section>
        <section
          className="repo-panels__refs"
          aria-label="Branches and stashes"
          tabIndex={-1}
        >
          <RefsView />
        </section>
        <section className="repo-panels__changes" aria-label="Working tree" tabIndex={-1}>
          <ChangesView />
        </section>
        <section className="repo-panels__diff" aria-label="Diff" tabIndex={-1}>
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
