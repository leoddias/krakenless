import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import './index.css';
import './app.css';
import {
  clampLayout,
  LAYOUT_BOUNDS,
  type AppConfig,
  type LayoutConfig,
} from './config/schema';
import { loadConfig, saveConfig } from './config/store';
import { closeRepo, openRepo, refreshAllPanels } from './state/actions';
import { useAppState, useStore } from './state/hooks';
import { createStore, isBusy, type AppState, type Store } from './state/store';
import { subscribeOpenRequests } from './state/openRequests';
import { publishConfig, registerStore } from './state/stores';
import { StoreProvider } from './state/StoreProvider';
import { startAutoFetch } from './state/autoFetch';
import { watchRepository, type WatchHandle } from './state/watch';
import { ChangesView } from './views/changes';
import { ConflictBanner } from './views/conflicts';
import { ConflictResolver } from './views/conflicts/ConflictResolver';
import { DiffView } from './views/diff';
import { SettingsView } from './views/settings';
import { RefsView } from './views/refs';
import { resolveShortcut } from './views/shell/shortcuts';
import { RemoteBar } from './views/remote';
import { DiscardBackups, NoticeBar } from './views/shell';
import { CheckoutPicker } from './views/shell/CheckoutPicker';
import {
  ChevronRightIcon,
  CloseIcon,
  RefreshIcon,
  RepoIcon,
  SettingsIcon,
} from './views/shell/icons';
import { Splitter } from './views/shell/Splitter';
import {
  activeTab,
  closeRepoTab,
  openRepoTab,
  type RepoTab,
  type Workspace as TabWorkspace,
} from './views/shell/tabs';
import { HistoryView } from './views/history/HistoryView';
import { UpdateBanner } from './views/update';
import { WelcomeView } from './views/welcome';

export const APP_NAME = 'Krakenless';

/** Reads a slice of a store that is not the one in context. */
function useStoreState<T>(store: Store, select: (state: AppState) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.getState()),
    () => select(store.getState()),
  );
}

/**
 * Loads the saved settings once and hands them to every open repository.
 *
 * Published rather than dispatched: the settings are one answer for the whole
 * app, and each tab has its own store (see `state/stores.ts`).
 */
function useLoadedConfig(): void {
  useEffect(() => {
    let cancelled = false;
    void loadConfig().then((config) => {
      if (!cancelled) publishConfig(config);
    });
    return () => {
      cancelled = true;
    };
  }, []);
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

/**
 * Fetches the open repository in the background, as often as the settings say.
 *
 * Separate from the filesystem watch on purpose: the watch answers "what
 * changed on this machine", and no amount of watching can report a branch that
 * somebody else pushed. Re-runs when the interval changes, so turning the
 * setting off in Settings stops the schedule then and there rather than at the
 * next repository.
 */
function useAutoFetch(root: string | null): void {
  const store = useStore();
  const minutes = useAppState((state) => state.config.autoFetchMinutes);

  useEffect(() => {
    if (root === null) return;
    const handle = startAutoFetch(store, root, minutes);
    return () => {
      void handle.stop();
    };
  }, [store, root, minutes]);
}

/**
 * The title bar: the way home, and one tab per open repository.
 *
 * The brand is a button, not decoration — it is how the user gets back to the
 * repository list without closing what they already have open.
 */
function TitleBar({
  tabs,
  activeId,
  onHome,
  onActivate,
  onClose,
}: {
  tabs: RepoTab<Store>[];
  activeId: string | null;
  onHome: () => void;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}): ReactNode {
  return (
    <div className="titlebar">
      <button
        type="button"
        className={
          activeId === null
            ? 'titlebar__brand titlebar__brand--active'
            : 'titlebar__brand'
        }
        aria-current={activeId === null ? 'page' : undefined}
        title="Open another repository"
        onClick={onHome}
      >
        {APP_NAME}
      </button>
      <div className="titlebar__tabs" role="tablist" aria-label="Open repositories">
        {tabs.map((tab) => (
          <div key={tab.id} className={tab.id === activeId ? 'tab tab--active' : 'tab'}>
            <button
              type="button"
              role="tab"
              aria-selected={tab.id === activeId}
              className="tab__button"
              title={tab.root}
              onClick={() => onActivate(tab.id)}
            >
              <RepoIcon size={13} />
              <span className="tab__name">{repoName(tab.root)}</span>
            </button>
            <button
              type="button"
              className="tab__close"
              aria-label={`Close ${repoName(tab.root)}`}
              onClick={() => onClose(tab.id)}
            >
              <CloseIcon size={11} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
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
          {/*
            A picker rather than a label: the branch is the thing people change
            most often, and it was the one fact in this bar that could only be
            read. It lists the worktrees too — see `CheckoutPicker` for why the
            two belong in one list.
          */}
          <CheckoutPicker />
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
        {/*
          Labelled, unlike its neighbour: Refresh repeats a keyboard shortcut
          people already know from every other app, while settings is where a
          user goes looking when they do not know what they are looking for —
          a bare glyph makes that a guess. The accessible name comes from the
          visible word now, so there is no second copy to drift from it.
        */}
        <button
          type="button"
          className="labelled-button"
          title="Settings"
          onClick={onOpenSettings}
        >
          <SettingsIcon />
          <span>Settings</span>
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
      // Every open tab, not just this one: the panel sizes are one setting.
      publishConfig(updated);
      void saveConfig(updated).catch(() => {
        // The size is already on screen; failing to remember it is not worth
        // an alert over the repository.
      });
      return null;
    });
  }, [config]);

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
 *
 * Scoped to the pane the user is looking at: with several repositories open,
 * every one of them has a panel called "History".
 */
function focusPanel(within: HTMLElement | null, label: string): void {
  const panel = (within ?? document).querySelector<HTMLElement>(
    `[aria-label="${label}"]`,
  );
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

/**
 * One open repository.
 *
 * Every open tab stays mounted, hidden when it is not the one on screen, so its
 * watcher keeps running and its panels stay current — coming back to a tab
 * shows what that repository looks like now, not what it looked like when you
 * left it.
 */
function RepoPane({
  active,
  onClose,
}: {
  active: boolean;
  onClose: () => void;
}): ReactNode {
  const store = useStore();
  const repo = useAppState((state) => state.repo);
  const root = repo.state === 'ready' ? repo.value.root : null;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const pane = useRef<HTMLDivElement | null>(null);

  useRepositoryWatch(root);
  useAutoFetch(root);

  useEffect(() => {
    // Only the pane on screen answers the keyboard. Every open tab is mounted,
    // and without this each one would act on the same key press — Ctrl+W would
    // close every repository at once.
    if (!active) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      const shortcut = resolveShortcut(event, { editable: isEditable(event.target) });
      if (shortcut === null) return;

      const panel = PANEL_LABEL[shortcut];
      if (panel !== undefined) {
        event.preventDefault();
        focusPanel(pane.current, panel);
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
        onClose();
      }
      // `commit` is handled by the changes panel, which owns the draft.
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [store, active, onClose]);

  if (root === null) return null;

  return (
    <div className="repo-pane" ref={pane} hidden={!active}>
      {settingsOpen ? (
        <SettingsView onClose={() => setSettingsOpen(false)} />
      ) : (
        <>
          <Toolbar
            root={root}
            name={repoName(root)}
            onOpenSettings={() => setSettingsOpen(true)}
          />
          <ConflictBanner />
          <NoticeBar />
          <DiscardBackups />
          <PanelGrid />
          <StatusBar root={root} />
          {/*
            Last, and above everything: resolving a conflict is the task while
            it is happening, and it is opened from two different panels.
          */}
          <ConflictResolver />
        </>
      )}
    </div>
  );
}

/**
 * The panels, wrapped so a layout change cannot re-render them.
 *
 * Each of these takes no props and reads the store itself, so `memo` makes a
 * re-render of the grid free for them: they update when their own data changes
 * and at no other time. Without it, every mouse-move of a splitter rebuilt the
 * entire commit list, the diff and the working tree — a few hundred rows and
 * their graph cells per frame — and the drag crawled while the layout it was
 * changing was three numbers.
 */
const Refs = memo(RefsView);
const History = memo(HistoryView);
const Diff = memo(DiffView);
const Changes = memo(ChangesView);

/** The three panels and the edges the user can drag. */
function PanelGrid(): ReactNode {
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
        <Refs />
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
          <History />
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
          <Diff />
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
        <Changes />
      </section>
    </div>
  );
}

/** Keeps a store on the list that receives settings changes. */
function useRegisteredStore(store: Store): void {
  useEffect(() => registerStore(store), [store]);
}

/** A store for a new tab, starting from the settings already in force. */
function makeTabStore(config: AppConfig): Store {
  const store = createStore();
  store.dispatch({ type: 'config/loaded', config });
  return store;
}

let nextTabId = 1;

export default function App(): ReactNode {
  useLoadedConfig();
  // The store the app was mounted with is where the welcome screen opens
  // repositories. When one opens, that store *becomes* the tab's store — the
  // loading it just did is the tab's state — and a fresh one takes its place
  // for the next visit home.
  const initial = useStore();
  const [home, setHome] = useState<Store>(initial);
  const [workspace, setWorkspace] = useState<TabWorkspace<Store>>({
    tabs: [],
    activeId: null,
  });

  useRegisteredStore(home);
  const homeRepo = useStoreState(home, (state) => state.repo);

  // A repository opened on the home screen becomes a tab. Reading the store
  // rather than wiring a callback through the welcome screen keeps every route
  // in — the folder picker, a recent row, a repository already open at mount —
  // going through one place.
  //
  // Adjusted during render rather than in an effect, the way `RefsView` handles
  // a changed repository: the tab list is *derived* from the store, and an
  // effect would let one frame paint the home screen over a repository that is
  // already open.
  if (homeRepo.state === 'ready') {
    const root = homeRepo.value.root;
    const adopted = home;
    setWorkspace((current) =>
      openRepoTab(current, root, () => ({
        id: `tab-${String(nextTabId++)}`,
        root,
        store: adopted,
      })),
    );
    setHome(makeTabStore(adopted.getState().config));
  }

  // A worktree row, or the branch picker, asking for another checkout. It opens
  // on the home store for one reason: that is the store the tab list is derived
  // from, so a path already open lands on its existing tab instead of a second
  // one pointed at the same directory.
  useEffect(() => subscribeOpenRequests((path) => void openRepo(home, path)), [home]);

  const closeTab = useCallback((id: string) => {
    setWorkspace((current) => {
      const tab = current.tabs.find((candidate) => candidate.id === id);
      // Closing the repository inside the store is what stops its watcher; the
      // store itself goes away with the tab.
      if (tab !== undefined) closeRepo(tab.store);
      return closeRepoTab(current, id);
    });
  }, []);

  const active = activeTab(workspace);
  // Read from the home store because the offer is about the application, not
  // about a repository: it belongs above the tabs and shows on the welcome
  // screen too, where there is no repository store to read.
  const autoUpdateCheck = useStoreState(home, (state) => state.config.autoUpdateCheck);

  return (
    <div className="repo-layout">
      <TitleBar
        tabs={workspace.tabs}
        activeId={workspace.activeId}
        onHome={() => setWorkspace((current) => ({ ...current, activeId: null }))}
        onActivate={(id) => setWorkspace((current) => ({ ...current, activeId: id }))}
        onClose={closeTab}
      />

      <UpdateBanner enabled={autoUpdateCheck} />

      {active === undefined && (
        <StoreProvider store={home}>
          <WelcomeView />
        </StoreProvider>
      )}

      {workspace.tabs.map((tab) => (
        <TabPane
          key={tab.id}
          tab={tab}
          active={tab.id === workspace.activeId}
          onClose={() => closeTab(tab.id)}
        />
      ))}
    </div>
  );
}

function TabPane({
  tab,
  active,
  onClose,
}: {
  tab: RepoTab<Store>;
  active: boolean;
  onClose: () => void;
}): ReactNode {
  useRegisteredStore(tab.store);
  return (
    <StoreProvider store={tab.store}>
      <RepoPane active={active} onClose={onClose} />
    </StoreProvider>
  );
}
