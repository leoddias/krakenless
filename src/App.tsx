import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import './index.css';
import './app.css';
import { clampLayout, LAYOUT_BOUNDS, type LayoutConfig } from './config/schema';
import { loadConfig, saveConfig } from './config/store';
import { closeRepo, refreshAllPanels } from './state/actions';
import { useAppState, useStore } from './state/hooks';
import { isBusy, type AppState } from './state/store';
import { watchRepository, type WatchHandle } from './state/watch';
import { ChangesView } from './views/changes';
import { ConflictBanner } from './views/conflicts';
import { DiffView } from './views/diff';
import { SettingsView } from './views/settings';
import { RefsView } from './views/refs';
import { resolveShortcut } from './views/shell/shortcuts';
import { RemoteBar } from './views/remote';
import { NoticeBar } from './views/shell';
import {
  ChevronRightIcon,
  CloseIcon,
  RefreshIcon,
  RepoIcon,
  SettingsIcon,
} from './views/shell/icons';
import { Splitter } from './views/shell/Splitter';
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

function TitleBar({ name, onClose }: { name: string; onClose: () => void }): ReactNode {
  return (
    <div className="titlebar">
      <span className="titlebar__brand">{APP_NAME}</span>
      <div className="titlebar__tabs">
        <div className="tab">
          <RepoIcon size={13} />
          <span className="tab__name">{name}</span>
          <button
            type="button"
            className="tab__close"
            aria-label="Close repository"
            onClick={onClose}
          >
            <CloseIcon size={11} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** What the toolbar says the checkout is, in the words the status supports. */
function branchText(status: AppState['status']): { text: string; muted: boolean } {
  switch (status.state) {
    case 'ready':
      return status.value.detached
        ? { text: 'detached HEAD', muted: true }
        : { text: status.value.branch ?? '—', muted: false };
    case 'loading':
      return { text: 'reading status…', muted: true };
    case 'error':
      return { text: 'status unavailable', muted: true };
    case 'idle':
      return { text: '—', muted: true };
  }
}

function Toolbar({
  root,
  name,
  onOpenSettings,
}: {
  root: string;
  name: string;
  onOpenSettings: () => void;
}): ReactNode {
  const store = useStore();
  const status = useAppState((state) => state.status);
  const branch = branchText(status);

  return (
    <header className="toolbar">
      <div className="toolbar__identity">
        <div className="toolbar__field">
          <span className="toolbar__caption">repository</span>
          <span className="toolbar__value" title={root}>
            {name}
          </span>
        </div>
        <span className="toolbar__separator" aria-hidden="true">
          <ChevronRightIcon size={12} />
        </span>
        <div className="toolbar__field">
          <span className="toolbar__caption">branch</span>
          <span
            className={
              branch.muted ? 'toolbar__value toolbar__value--muted' : 'toolbar__value'
            }
            title={status.state === 'error' ? status.message : undefined}
          >
            {branch.text}
          </span>
        </div>
        {status.state === 'ready' && status.value.hasConflicts && (
          <span className="toolbar__conflicts">conflicts</span>
        )}
      </div>

      <RemoteBar />

      <div className="toolbar__right">
        {/*
          The panels follow the repository on their own, but a filesystem watch
          can miss a change — a network share, an editor that writes through a
          temporary file, a burst that overflows the OS buffer. Ctrl+R has
          always done this; without a button it was a shortcut nobody could
          discover at the moment they needed it.
        */}
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh"
          title="Re-read the repository (Ctrl+R)"
          onClick={() => void refreshAllPanels(store)}
        >
          <RefreshIcon />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Settings"
          title="Settings"
          onClick={onOpenSettings}
        >
          <SettingsIcon />
        </button>
      </div>
    </header>
  );
}

/**
 * The bottom band: where the repository is, and whether git is running.
 *
 * It deliberately does not repeat the branch — that is the toolbar's job, and
 * two copies of one fact are two things to keep in sync.
 */
function StatusBar({ root }: { root: string }): ReactNode {
  const busy = useAppState(isBusy);

  return (
    <footer className="statusbar">
      <span className="statusbar__path" title={root}>
        {root}
      </span>
      <span className="statusbar__right">
        {busy && (
          <span className="statusbar__busy" role="status">
            working…
          </span>
        )}
      </span>
    </footer>
  );
}

/** Last path segment of the repository root — the name the user calls it by. */
function repoName(root: string): string {
  // Split on both separators: a Windows root arrives with backslashes, and a
  // repository opened over a UNC path mixes the two.
  const parts = root.split('/').flatMap((part) => part.split('\\'));
  return parts.filter(Boolean).pop() ?? root;
}

/**
 * The panel sizes, and the machinery for dragging them.
 *
 * The size on screen comes from the config while nothing is being dragged, and
 * from a local draft while something is: writing every mouse-move to disk would
 * be hundreds of file writes per drag. The draft is discarded when the drag
 * ends and the result is saved once. A failed save costs the user a panel size,
 * never the session, so it is swallowed rather than surfaced.
 */
function useLayout(): {
  layout: LayoutConfig;
  beginDrag: () => void;
  setLayout: (next: LayoutConfig) => void;
  endDrag: () => void;
  startRef: React.RefObject<LayoutConfig>;
} {
  const store = useStore();
  const config = useAppState((state) => state.config);
  const [draft, setDraft] = useState<LayoutConfig | null>(null);
  const layout = draft ?? config.layout;
  // The layout as it was when the current drag started; every delta is applied
  // to this, so a drag cannot compound its own output.
  const startRef = useRef<LayoutConfig>(layout);

  const beginDrag = useCallback(() => {
    startRef.current = layout;
  }, [layout]);

  const setLayout = useCallback((next: LayoutConfig) => {
    setDraft(clampLayout(next));
  }, []);

  const endDrag = useCallback(() => {
    setDraft((current) => {
      if (current === null) return null;
      const updated = { ...config, layout: current };
      store.dispatch({ type: 'config/loaded', config: updated });
      void saveConfig(updated).catch(() => {
        // The size is already on screen; failing to remember it is not worth
        // an alert over the repository.
      });
      return null;
    });
  }, [config, store]);

  return { layout, beginDrag, setLayout, endDrag, startRef };
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
  const name = repoName(root);

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
      <TitleBar name={name} onClose={() => closeRepo(store)} />
      <Toolbar root={root} name={name} onOpenSettings={() => setSettingsOpen(true)} />
      <ConflictBanner />
      <NoticeBar />
      <Workspace />
      <StatusBar root={root} />
    </div>
  );
}

/** The three panels and the two-and-a-half edges the user can drag. */
function Workspace(): ReactNode {
  const { layout, beginDrag, setLayout, endDrag, startRef } = useLayout();
  // The centre column's height, needed to turn a vertical drag into a share.
  // Read at the start of each drag rather than watched, since it cannot change
  // while the mouse is down.
  const centre = useRef<HTMLDivElement | null>(null);
  const centreHeight = useRef(0);

  const dragHistory = (delta: number): void => {
    const height = centreHeight.current;
    if (height <= 0) return;
    setLayout({
      ...startRef.current,
      historyRatio: startRef.current.historyRatio + delta / height,
    });
  };

  return (
    <div
      className="repo-panels"
      style={{
        gridTemplateColumns: `${String(layout.sidebarWidth)}px 5px minmax(0, 1fr) 5px ${String(layout.detailWidth)}px`,
      }}
    >
      <section
        className="repo-panels__refs"
        aria-label="Branches and stashes"
        tabIndex={-1}
      >
        <RefsView />
      </section>

      <Splitter
        orientation="vertical"
        label="Resize the branches panel"
        value={layout.sidebarWidth}
        min={LAYOUT_BOUNDS.sidebarWidth.min}
        max={LAYOUT_BOUNDS.sidebarWidth.max}
        onDragStart={beginDrag}
        onDrag={(delta) =>
          setLayout({
            ...startRef.current,
            sidebarWidth: startRef.current.sidebarWidth + delta,
          })
        }
        onDragEnd={endDrag}
        onNudge={(delta) => {
          beginDrag();
          setLayout({ ...layout, sidebarWidth: layout.sidebarWidth + delta });
          endDrag();
        }}
      />

      <div className="repo-panels__center" ref={centre}>
        <section
          className="repo-panels__history"
          aria-label="History"
          tabIndex={-1}
          style={{ flexGrow: layout.historyRatio }}
        >
          <HistoryView />
        </section>

        <Splitter
          orientation="horizontal"
          label="Resize the history panel"
          // Reported as a percentage: "62" is a number a screen reader can read
          // out, where 0.62 is not.
          value={layout.historyRatio * 100}
          min={LAYOUT_BOUNDS.historyRatio.min * 100}
          max={LAYOUT_BOUNDS.historyRatio.max * 100}
          onDragStart={() => {
            centreHeight.current = centre.current?.clientHeight ?? 0;
            beginDrag();
          }}
          onDrag={dragHistory}
          onDragEnd={endDrag}
          onNudge={(delta) => {
            centreHeight.current = centre.current?.clientHeight ?? 0;
            beginDrag();
            dragHistory(delta);
            endDrag();
          }}
        />

        <section
          className="repo-panels__diff"
          aria-label="Diff"
          tabIndex={-1}
          style={{ flexGrow: 1 - layout.historyRatio }}
        >
          <DiffView />
        </section>
      </div>

      <Splitter
        orientation="vertical"
        label="Resize the working tree panel"
        value={layout.detailWidth}
        min={LAYOUT_BOUNDS.detailWidth.min}
        max={LAYOUT_BOUNDS.detailWidth.max}
        onDragStart={beginDrag}
        // Dragging right makes the panel on the *right* narrower, so the sign
        // is inverted against the other edge.
        onDrag={(delta) =>
          setLayout({
            ...startRef.current,
            detailWidth: startRef.current.detailWidth - delta,
          })
        }
        onDragEnd={endDrag}
        onNudge={(delta) => {
          beginDrag();
          setLayout({ ...layout, detailWidth: layout.detailWidth - delta });
          endDrag();
        }}
      />

      <section className="repo-panels__changes" aria-label="Working tree" tabIndex={-1}>
        <ChangesView />
      </section>
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
