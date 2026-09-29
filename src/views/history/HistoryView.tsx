/**
 * The history panel: the commit list, and the selection that drives the diff.
 *
 * Rendering is windowed by hand — a repository with tens of thousands of
 * commits must not put tens of thousands of DOM nodes on screen — using a
 * fixed row height so the mapping between scroll offset and row index stays a
 * division instead of a measurement pass.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type UIEvent,
} from 'react';
import type { Commit, CommitRef, RefKind, StashEntry } from '../../git/types';
import { selectCommit, switchTo, switchToRemote } from '../../state/actions';
import { useAppState, useStore } from '../../state/hooks';
import { isBusy, type Loadable } from '../../state/store';
import { formatAbsoluteDate, formatRelativeDate } from './relativeTime';
import { GraphCell } from './GraphCell';
import { useAuthorPictures } from './avatarCache';
import { HISTORY_COLUMN_BOUNDS, type HistoryColumns } from '../../config/schema';
import { ContextMenu } from '../shell/ContextMenu';
import { Splitter } from '../shell/Splitter';
import { edgeHandlers, useLayout, type LayoutHandle } from '../shell/useLayout';
import { avatarIdentity } from './remoteAvatar';
import { buildGraph, type GraphRow } from './graph';
import { CommitActions, DialogHost, type CommitMenuTarget } from './CommitActions';
import { mergeDialog } from './mergeDialog';
import { stashDialog } from './stashDialog';
import { applyStashes, stashRowLabel } from './stashRows';
import {
  tallyParts,
  tallySentence,
  tallyTracked,
  tallyWorkingTree,
  type WorkingTreeTally,
} from './workingTreeTally';
import { stashRefusalReason } from './stashDialog';
import {
  applyWorktrees,
  isWorktreeRow,
  worktreeChangeSummary,
  worktreeName,
} from './worktreeRows';
import { refPath } from '../shell/refName';
import { remoteSwitchFor } from './remoteSwitch';
import type { WorktreeSummary } from '../../git/worktrees';
import { requestOpenRepository } from '../../state/openRequests';
import {
  checkedOutBranch,
  isCurrentChip,
  isHeadRow,
  isRedundantHeadChip,
  rowSwitchesTo,
} from './headRef';
import {
  FIND_COMMITS_EVENT,
  commitMessage,
  findMatches,
  splitMatches,
  stepMatch,
} from './commitSearch';
import styles from './history.module.css';

/** Height of one row in pixels; must match `.row` in the stylesheet. */
export const ROW_HEIGHT = 30;
/**
 * Size asked of the avatar host. Twice the badge's 16px so it stays sharp on a
 * 2x display, and small enough that a cached picture is a couple of kilobytes.
 */
const AVATAR_PIXELS = 32;
/**
 * Height the find bar covers at the top of the list, so a match is never
 * scrolled to just underneath it.
 */
const FIND_BAR_INSET = 44;
/** Rows kept mounted above and below the viewport, to hide scroll latency. */
const OVERSCAN = 6;
/**
 * Used until the viewport reports a height (first paint, and test
 * environments without layout), so the list is never empty for lack of a
 * measurement.
 */
const FALLBACK_VIEWPORT_HEIGHT = 480;

/** The history panel. Reads `state.commits` and owns no state of its own. */
export function HistoryView(): ReactNode {
  const commits = useAppState((state) => state.commits);
  const layout = useLayout();
  const columns = layout.layout.historyColumns;
  const panel = useRef<HTMLElement | null>(null);
  /**
   * Whether the find bar is open. Kept here, above the list, because the list
   * unmounts whenever the history is not ready — state inside it would reset
   * and a stale request could reopen the bar by itself.
   */
  const [findOpen, setFindOpen] = useState(false);
  /**
   * Bumped by every Ctrl+F. A counter rather than a flag, so pressing it again
   * with the bar already open still moves focus back into it.
   */
  const [findRequest, setFindRequest] = useState(0);
  const ready = commits.state === 'ready';
  // A history that is loading or failed has nothing to search, and a bar left
  // open over it would come back unasked when the list does.
  if (!ready && findOpen) setFindOpen(false);
  useEffect(() => {
    const element = panel.current;
    // Not listening at all until the list is ready: a request is dropped rather
    // than queued, because a bar that opens seconds later, when the list
    // arrives, takes focus from whatever the user moved on to.
    if (element === null || !ready) return;
    const onFind = (): void => {
      setFindOpen(true);
      setFindRequest((count) => count + 1);
    };
    element.addEventListener(FIND_COMMITS_EVENT, onFind);
    return () => element.removeEventListener(FIND_COMMITS_EVENT, onFind);
  }, [ready]);
  const find: FindState = {
    open: findOpen,
    request: findRequest,
    close: () => setFindOpen(false),
  };
  return (
    <section
      ref={panel}
      data-find-commits="true"
      className={styles.panel}
      aria-label="History"
      // The saved widths reach every row through the stylesheet, so a drag
      // re-renders the header and moves a thousand rows without touching them.
      style={
        {
          '--column-refs': `${String(columns.refs)}px`,
          '--column-graph': `${String(columns.graph)}px`,
          '--column-author': `${String(columns.author)}px`,
          '--column-oid': `${String(columns.oid)}px`,
          '--column-date': `${String(columns.date)}px`,
        } as React.CSSProperties
      }
    >
      <div className={styles.head}>
        <h2 className={styles.srOnly}>History</h2>
        <span className={`${styles.columnRefs} ${styles.columnLabel}`}>Branch / Tag</span>
        <ColumnEdge
          layout={layout}
          column="refs"
          label="Resize the branch and tag column"
        />
        <span className={`${styles.columnGraph} ${styles.columnLabel}`}>Graph</span>
        <ColumnEdge layout={layout} column="graph" label="Resize the graph column" />
        <span className={`${styles.columnSubject} ${styles.columnLabel}`}>
          Commit message
        </span>
        {/*
          The message takes whatever is left, so its trailing edge cannot size
          it: dragging that edge right narrows the author column instead, which
          is what the eye expects a boundary between two columns to do.
        */}
        <ColumnEdge
          layout={layout}
          column="author"
          direction={-1}
          label="Resize the commit message column"
        />
        <span className={`${styles.columnAuthor} ${styles.columnLabel}`}>Author</span>
        <ColumnEdge layout={layout} column="author" label="Resize the author column" />
        <span className={`${styles.columnOid} ${styles.columnLabel}`}>Commit</span>
        <ColumnEdge layout={layout} column="oid" label="Resize the commit column" />
        <span className={`${styles.columnDate} ${styles.columnLabel}`}>When</span>
        <ColumnEdge layout={layout} column="date" label="Resize the when column" />
      </div>
      <Body commits={commits} find={find} />
    </section>
  );
}

/**
 * The draggable boundary after a column label.
 *
 * `direction` is which way the named column grows when the pointer moves
 * right: `1` when the edge is on its trailing side, `-1` when the edge is on
 * its leading side and dragging right makes it narrower.
 */
function ColumnEdge({
  layout,
  column,
  label,
  direction = 1,
}: {
  layout: LayoutHandle;
  column: keyof HistoryColumns;
  label: string;
  direction?: 1 | -1;
}): ReactNode {
  const bounds = HISTORY_COLUMN_BOUNDS[column];
  return (
    <span className={styles.columnEdge}>
      <Splitter
        orientation="vertical"
        label={label}
        value={layout.layout.historyColumns[column]}
        min={bounds.min}
        max={bounds.max}
        {...edgeHandlers(
          layout,
          (current) => current.historyColumns[column],
          (current, value) => ({
            ...current,
            historyColumns: { ...current.historyColumns, [column]: value },
          }),
          direction,
        )}
      />
    </span>
  );
}

/** The find bar's state, owned by {@link HistoryView}. */
interface FindState {
  open: boolean;
  /** Counts Ctrl+F presses; each new one focuses the box. */
  request: number;
  close: () => void;
}

function Body({
  commits,
  find,
}: {
  commits: Loadable<Commit[]>;
  find: FindState;
}): ReactNode {
  switch (commits.state) {
    case 'idle':
      return <p className={styles.notice}>Open a repository to see its history.</p>;
    case 'loading':
      return (
        <p className={styles.notice} role="status">
          Loading history…
        </p>
      );
    case 'error':
      return (
        <div className={styles.error} role="alert">
          <p className={styles.errorTitle}>The history could not be loaded.</p>
          <p className={styles.errorMessage}>{commits.message}</p>
          {commits.kind !== undefined && (
            <p className={styles.errorKind}>Reason: {commits.kind}</p>
          )}
        </div>
      );
    case 'ready':
      return <CommitList commits={commits.value} find={find} />;
  }
}

function CommitList({
  commits: loaded,
  find,
}: {
  commits: Commit[];
  find: FindState;
}): ReactNode {
  const store = useStore();
  const selectedOid = useAppState((state) => state.selection.commitOid);
  // `git log --all` walks `refs/stash` too, so a stash arrives as three rows of
  // git bookkeeping. The stash list is what identifies them; until it has been
  // read the history is drawn as git reported it (see `stashRows.ts`).
  const stashList = useAppState((state) => state.stashes);
  // Off unless the user turned it on; see ADR-0021. Read once for the list
  // rather than per row, so a re-render cannot leave half the graph fetching.
  const remoteAvatars = useAppState((state) => state.config.remoteAvatars);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(FALLBACK_VIEWPORT_HEIGHT);
  /** Set by keyboard navigation only, so a mouse click never steals focus. */
  const focusSelected = useRef(false);
  /** The commit whose context menu is open, and where it was opened. */
  const [menuTarget, setMenuTarget] = useState<CommitMenuTarget | null>(null);
  /** Where the working-tree row's own menu was opened, when it is open. */
  const [treeMenu, setTreeMenu] = useState<{ x: number; y: number } | null>(null);
  const [stashing, setStashing] = useState(false);
  /**
   * The branch being dragged, or `null`.
   *
   * The name is kept here rather than read back out of the drop event: the
   * `dataTransfer` payload exists to make the browser start a drag at all, and
   * a chip dragged in from another window would arrive with text this list has
   * no business acting on.
   */
  const [dragged, setDragged] = useState<string | null>(null);
  /**
   * The commit whose row is being dragged, or `null`. A row drag ends in a
   * context menu on the row it lands on — a question, never an action.
   */
  const [draggedRow, setDraggedRow] = useState<string | null>(null);
  /** The row a drag is currently over and may be dropped on, for the outline. */
  const [dropRow, setDropRow] = useState<string | null>(null);
  /** The merge a drop asked for, waiting on its question. */
  const [dropMerge, setDropMerge] = useState<{ branch: string; ref: string } | null>(
    null,
  );
  const busy = useAppState(isBusy);
  const status = useAppState((state) => state.status);
  const operation = useAppState((state) => state.operation);

  const worktreeList = useAppState((state) => state.worktrees);
  const { commits, stashes, worktreeRows } = useMemo(() => {
    const stashed = applyStashes(loaded, stashList);
    // Worktrees last: they hang off commits, and the stash pass is what decides
    // which commits are on the list at all.
    const withWorktrees = applyWorktrees(stashed.commits, worktreeList);
    return {
      commits: withWorktrees.commits,
      stashes: stashed.stashes,
      worktreeRows: withWorktrees.worktreeRows,
    };
  }, [loaded, stashList, worktreeList]);

  // Row 0 is the working tree; commit `i` lives at row `i + 1`.
  const total = commits.length + 1;
  // Laid out once per list, not per rendered row: the lanes depend on every
  // commit before them, so a windowed slice cannot compute them on its own.
  const graph = useMemo(() => buildGraph(commits), [commits]);
  const selectedIndex = selectedOid === null ? 0 : indexOfOid(commits, selectedOid);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const measure = (): void => {
      if (viewport.clientHeight > 0) setViewportHeight(viewport.clientHeight);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  useEffect(() => {
    if (!focusSelected.current) return;
    focusSelected.current = false;
    const viewport = viewportRef.current;
    // A selection outside the loaded page has no row; the tabbable one is
    // still somewhere in the list for the keyboard to be.
    const row =
      viewport?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`) ??
      viewport?.querySelector<HTMLElement>('[data-index][tabindex="0"]');
    row?.focus();
  });

  /**
   * Scrolls as little as it takes to bring a row into view, below the top
   * `inset` pixels when something floats over them.
   */
  const reveal = useCallback(
    (index: number, inset = 0): void => {
      const next = Math.max(
        0,
        scrollOffsetFor(index, scrollTop + inset, viewportHeight - inset) - inset,
      );
      if (next !== scrollTop) {
        setScrollTop(next);
        if (viewportRef.current !== null) viewportRef.current.scrollTop = next;
      }
    },
    [scrollTop, viewportHeight],
  );

  const select = useCallback(
    (index: number, viaKeyboard: boolean): void => {
      const target = clamp(index, 0, total - 1);
      const commit = target === 0 ? null : commits[target - 1];
      // Clamping keeps `target` in range, so this only guards against a list
      // that changed under us between render and event.
      if (target !== 0 && commit === undefined) return;
      if (viaKeyboard) {
        focusSelected.current = true;
        reveal(target);
      }
      // A worktree's WIP row stands for uncommitted work in another checkout:
      // there is no object to show a diff of, and asking git for one would be
      // asking about a sha that does not exist. The row keeps focus — it is
      // still somewhere the keyboard can be — and the selection stays put.
      if (commit !== null && commit !== undefined && isWorktreeRow(commit.oid)) return;
      void selectCommit(
        store,
        commit === null || commit === undefined ? null : commit.oid,
      );
    },
    [commits, reveal, store, total],
  );

  // --- find (Ctrl+F) ---------------------------------------------------------
  const findOpen = find.open;
  const findRequest = find.request;
  /**
   * The request the box was last focused for. Starts at the count this list
   * mounted with, so mounting alone never pulls focus into the box.
   */
  const focusedRequest = useRef(findRequest);
  const [query, setQuery] = useState('');
  const findInput = useRef<HTMLInputElement | null>(null);
  /** Positions in `commits` whose message matches; row `i + 1` on screen. */
  // A stash row shows what was set aside, not git's "WIP on main: …" subject,
  // so that label is what it is searched by: a match must be visible.
  const messageOf = useCallback(
    (commit: Commit): string => {
      const entry = stashes.get(commit.oid);
      return entry === undefined ? commitMessage(commit) : stashRowLabel(entry);
    },
    [stashes],
  );
  const matches = useMemo(
    () => (findOpen ? findMatches(commits, query, messageOf) : []),
    [commits, findOpen, messageOf, query],
  );
  const matched = useMemo(() => new Set(matches), [matches]);
  /** Rows only dim once there is something to look for. */
  const searching = findOpen && query.trim() !== '';
  // -1 for the working-tree row and for a selection outside the loaded page:
  // both mean "start from the top".
  const currentPosition = Math.max(-1, selectedIndex - 1);

  useEffect(() => {
    if (!findOpen || focusedRequest.current === findRequest) return;
    focusedRequest.current = findRequest;
    findInput.current?.focus();
    findInput.current?.select();
  }, [findOpen, findRequest]);

  /**
   * Selects a match without taking focus from the find box, so the user can
   * keep typing or press Enter again.
   */
  const goToMatch = (found: number[], direction: -1 | 0 | 1): void => {
    const position = stepMatch(found, currentPosition, direction);
    if (position === null) return;
    reveal(position + 1, FIND_BAR_INSET);
    if (position !== currentPosition) select(position + 1, false);
  };

  const onQueryChange = (next: string): void => {
    setQuery(next);
    goToMatch(findMatches(commits, next, messageOf), 0);
  };

  const closeFind = (): void => {
    find.close();
    setQuery('');
    // Back to the list, on the commit the search left selected.
    focusSelected.current = true;
    reveal(Math.max(0, selectedIndex));
  };

  const onFindKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      goToMatch(matches, event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeFind();
    }
  };

  const matchNumber = matches.indexOf(currentPosition) + 1;

  /**
   * Right-click on a commit: select it, then open the menu where the pointer is.
   *
   * Selecting first is what makes the menu unambiguous — the diff below and the
   * highlighted row both name the commit the menu is about, so an item chosen a
   * second later cannot be read as applying to whatever was selected before.
   */
  const openMenuAt = (commit: Commit, x: number, y: number): void => {
    // The row index is looked up rather than captured from the render loop, so
    // the handler holds no reference to a variable the loop goes on to change.
    const index = indexOfOid(commits, commit.oid);
    if (index === -1) return;
    select(index, false);
    const entry = stashes.get(commit.oid);
    setMenuTarget({
      commit,
      x,
      y,
      ...(entry === undefined ? {} : { stash: entry }),
    });
  };

  const openMenu = (commit: Commit, event: ReactMouseEvent<HTMLElement>): void => {
    event.preventDefault();
    openMenuAt(commit, event.clientX, event.clientY);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        select(selectedIndex + 1, true);
        return;
      case 'ArrowUp':
        event.preventDefault();
        select(selectedIndex - 1, true);
        return;
      case 'Home':
        event.preventDefault();
        select(0, true);
        return;
      case 'End':
        event.preventDefault();
        select(total - 1, true);
        return;
      default:
        return;
    }
  };

  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    setScrollTop(event.currentTarget.scrollTop);
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(
    total,
    first + Math.ceil(viewportHeight / ROW_HEIGHT) + 1 + OVERSCAN * 2,
  );
  // Exactly one row is tabbable; when the selected one is scrolled out of the
  // window, the first mounted row takes over so the list stays reachable.
  const tabbableIndex =
    selectedIndex >= first && selectedIndex < last ? selectedIndex : first;

  // Only the authors on screen, and only when the user asked for pictures:
  // the window is what bounds how many identities are ever looked up.
  const visibleEmails = useMemo(
    () =>
      remoteAvatars
        ? commits
            .slice(Math.max(0, first - 1), Math.max(0, last - 1))
            .map((commit) => commit.authorEmail)
        : [],
    [commits, first, last, remoteAvatars],
  );
  const pictures = useAuthorPictures(visibleEmails, remoteAvatars, AVATAR_PIXELS);

  /**
   * Dragging a branch chip onto the checked-out one merges it in.
   *
   * Delegated to the list rather than wired per chip: the rows are windowed and
   * re-created as the user scrolls, and a drag that outlived its own chip would
   * be a listener on a node that no longer exists. Only two kinds of element
   * take part — a branch chip that is not the checkout (`draggable`), and the
   * checkout's own chip (`data-drop-target`) — so both ends of the gesture are
   * a `closest()` away.
   *
   * Keyboard users are not left out and never depended on this: the same merge
   * is on the commit's context menu, which is reachable with the keyboard.
   */
  const chipUnder = (
    event: ReactDragEvent<HTMLElement>,
    selector: string,
  ): string | null => {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    return target.closest(selector)?.getAttribute('data-ref-name') ?? null;
  };

  /** The commit row under the pointer, by the oid it carries, or `null`. */
  const rowUnder = (event: ReactDragEvent<HTMLElement>): string | null => {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    return target.closest('[data-drag-oid]')?.getAttribute('data-drag-oid') ?? null;
  };

  const endDrag = (): void => {
    setDragged(null);
    setDraggedRow(null);
    setDropRow(null);
  };

  /**
   * A drag starts on a branch chip, or failing that on the row itself. Either
   * way the row's oid is kept too: a chip dropped somewhere other than the
   * checkout's chip lands on a row, and a row is answered with its menu.
   */
  const onDragStart = (event: ReactDragEvent<HTMLElement>): void => {
    const name = chipUnder(event, '[data-ref-name][draggable="true"]');
    const oid = rowUnder(event);
    if (name === null && oid === null) return;
    setDragged(name);
    setDraggedRow(oid);
    // Firefox refuses to start a drag with an empty payload, and a plain-text
    // branch name (or sha) is a reasonable thing to drop into an editor besides.
    event.dataTransfer.setData('text/plain', name ?? oid ?? '');
    event.dataTransfer.effectAllowed = 'move';
  };

  /**
   * What a drop here would do. A branch chip over the checkout's chip is the
   * merge (ADR-0026); anything of ours over another commit's row opens that
   * row's context menu where the pointer is (ADR-0061). The row a drag started
   * on is not a target: a menu for the commit already in hand is a right-click.
   */
  const dropTargetFor = (
    event: ReactDragEvent<HTMLElement>,
  ): { kind: 'merge'; branch: string } | { kind: 'menu'; oid: string } | null => {
    if (dragged === null && draggedRow === null) return null;
    if (dragged !== null) {
      const onto = chipUnder(event, '[data-drop-target="true"]');
      // Dropping a branch on itself is the one merge that can never mean
      // anything, and the chip is its own nearest target while being dragged.
      if (onto !== null && onto !== dragged) return { kind: 'merge', branch: onto };
    }
    const oid = rowUnder(event);
    if (oid === null || oid === draggedRow) return null;
    return { kind: 'menu', oid };
  };

  const onDragOver = (event: ReactDragEvent<HTMLElement>): void => {
    const target = dropTargetFor(event);
    const over = target?.kind === 'menu' ? target.oid : null;
    if (over !== dropRow) setDropRow(over);
    if (target === null) return;
    // Without this the browser treats the spot as a place a drop cannot land.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };

  const onDrop = (event: ReactDragEvent<HTMLElement>): void => {
    const target = dropTargetFor(event);
    if (target === null) return;
    event.preventDefault();
    const ref = dragged;
    endDrag();
    if (target.kind === 'merge') {
      if (ref !== null) setDropMerge({ branch: target.branch, ref });
      return;
    }
    const commit = commits.find((one) => one.oid === target.oid);
    if (commit !== undefined) openMenuAt(commit, event.clientX, event.clientY);
  };

  const readyStatus = status.state === 'ready' ? status.value : null;
  const tally = tallyWorkingTree(readyStatus);
  // What a stash would actually move, which is not what the row shows: see
  // `tallyTracked`.
  const trackedTally = tallyTracked(readyStatus);
  const stashRefusal = stashRefusalReason(operation, busy, trackedTally);

  const rows: ReactNode[] = [];
  for (let index = first; index < last; index += 1) {
    const shared = {
      index,
      selected: index === selectedIndex,
      tabbable: index === tabbableIndex,
      dimmed: searching && !matched.has(index - 1),
      onSelect: select,
    };
    if (index === 0) {
      rows.push(
        <WorkingTreeRow
          key="working-tree"
          tally={tally}
          onContextMenu={(event) => {
            event.preventDefault();
            select(0, false);
            setTreeMenu({ x: event.clientX, y: event.clientY });
          }}
          {...shared}
        />,
      );
      continue;
    }
    const commit = commits[index - 1];
    if (commit === undefined) continue;
    const worktree = worktreeRows.get(commit.oid);
    if (worktree !== undefined) {
      rows.push(
        <WorktreeRow
          key={commit.oid}
          worktree={worktree}
          graphRow={graph.rows[index - 1]}
          laneCount={graph.laneCount}
          {...shared}
        />,
      );
      continue;
    }
    const identity = avatarIdentity(commit.authorEmail);
    rows.push(
      <CommitRow
        key={commit.oid}
        commit={commit}
        graphRow={graph.rows[index - 1]}
        laneCount={graph.laneCount}
        avatarUrl={identity === null ? null : (pictures.get(identity) ?? null)}
        stash={stashes.get(commit.oid)}
        search={searching ? query : ''}
        dropHere={dropRow === commit.oid}
        onContextMenu={(event) => openMenu(commit, event)}
        {...shared}
      />,
    );
  }

  return (
    <div className={styles.listArea}>
      {findOpen && (
        <div className={styles.find} role="search" aria-label="Find commits">
          <input
            ref={findInput}
            className={styles.findInput}
            type="text"
            aria-label="Find commits by message"
            placeholder="Find in commit messages"
            spellCheck={false}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={onFindKeyDown}
          />
          <span
            className={styles.findCount}
            role="status"
            // A miss is about the loaded page, not the repository: say how far
            // back the search looked (ADR-0060).
            title={`Searches the ${String(commits.length)} most recent commits loaded; the History limit in Settings sets how far back that goes.`}
          >
            {!searching
              ? ''
              : matches.length === 0
                ? 'No matches'
                : matchNumber === 0
                  ? `${String(matches.length)} found`
                  : `${String(matchNumber)} of ${String(matches.length)}`}
          </span>
          <button
            type="button"
            className={styles.findButton}
            aria-label="Previous match"
            title="Previous match (Shift+Enter)"
            disabled={matches.length === 0}
            onClick={() => goToMatch(matches, -1)}
          >
            ↑
          </button>
          <button
            type="button"
            className={styles.findButton}
            aria-label="Next match"
            title="Next match (Enter)"
            disabled={matches.length === 0}
            onClick={() => goToMatch(matches, 1)}
          >
            ↓
          </button>
          <button
            type="button"
            className={styles.findButton}
            aria-label="Close find"
            title="Close (Escape)"
            onClick={closeFind}
          >
            ✕
          </button>
        </div>
      )}
      <div
        className={styles.viewport}
        ref={viewportRef}
        role="group"
        aria-label="Commits"
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragEnd={endDrag}
        onDragLeave={(event) => {
          // Leaving the list altogether: nothing is under the pointer any more.
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDropRow(null);
          }
        }}
        // Drives the affordance: while a branch is in the air, the chip it can
        // be dropped on says so. One target, so one attribute is enough.
        data-merge-drag={dragged === null ? undefined : 'true'}
      >
        <div className={styles.spacer} style={{ height: total * ROW_HEIGHT }}>
          {rows}
        </div>
        {commits.length === 0 && (
          <p className={styles.notice}>
            No commits yet — this repository has no history.
          </p>
        )}
        {menuTarget !== null && (
          <CommitActions target={menuTarget} onDismiss={() => setMenuTarget(null)} />
        )}
        {treeMenu !== null && (
          <ContextMenu
            sections={[
              [
                {
                  id: 'stash',
                  label: 'Stash tracked changes…',
                  disabled: stashRefusal,
                  ...(stashRefusal === null
                    ? {
                        onSelect: () => {
                          setStashing(true);
                        },
                      }
                    : {}),
                },
              ],
            ]}
            x={treeMenu.x}
            y={treeMenu.y}
            label="Working tree"
            onClose={() => setTreeMenu(null)}
          />
        )}
        {stashing && (
          <DialogHost
            dialog={stashDialog(store, trackedTally)}
            busy={busy}
            onClose={() => setStashing(false)}
          />
        )}
        {dropMerge !== null && (
          <DialogHost
            dialog={mergeDialog(store, dropMerge.branch, dropMerge.ref, dropMerge.ref)}
            busy={busy}
            onClose={() => setDropMerge(null)}
          />
        )}
      </div>
    </div>
  );
}

interface RowProps {
  index: number;
  selected: boolean;
  tabbable: boolean;
  /** Set while a search is open and this row is not one of its matches. */
  dimmed?: boolean;
  onSelect: (index: number, viaKeyboard: boolean) => void;
}

/** Rows that have a context menu carry the handler. */
interface MenuRowProps {
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}

const TALLY_CLASS: Record<keyof WorkingTreeTally, string> = {
  added: styles.tallyAdded ?? '',
  modified: styles.tallyModified ?? '',
  deleted: styles.tallyDeleted ?? '',
};

function WorkingTreeRow({
  index,
  selected,
  tabbable,
  dimmed,
  onSelect,
  tally,
  onContextMenu,
}: RowProps & {
  tally: WorkingTreeTally;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}): ReactNode {
  const parts = tallyParts(tally);
  const sentence = tallySentence(tally);
  return (
    <RowButton
      index={index}
      selected={selected}
      tabbable={tabbable}
      dimmed={dimmed}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
      label={`Working tree, uncommitted changes: ${sentence}`}
    >
      <span className={styles.columnRefs} />
      <span className={styles.columnGraph} />
      <span className={styles.columnSubject}>
        <span className={styles.wip}>Working tree</span>
        <span className={styles.wipNote}>Uncommitted changes</span>
        {parts.length > 0 && (
          <span className={styles.tally} title={sentence} aria-hidden="true">
            {parts.map((part) => (
              <span key={part.key} className={TALLY_CLASS[part.key]}>
                {part.text}
              </span>
            ))}
          </span>
        )}
      </span>
      <span className={styles.columnAuthor} />
      <span className={styles.columnOid} aria-hidden="true">
        —
      </span>
      <span className={styles.columnDate} />
    </RowButton>
  );
}

function CommitRow({
  commit,
  graphRow,
  laneCount,
  avatarUrl,
  stash,
  search,
  dropHere,
  index,
  selected,
  tabbable,
  dimmed,
  onSelect,
  onContextMenu,
}: RowProps &
  MenuRowProps & {
    commit: Commit;
    /** Set while a dragged row is over this one and may be dropped on it. */
    dropHere: boolean;
    graphRow: GraphRow | undefined;
    laneCount: number;
    /**
     * The author's fetched picture, once it has arrived. `null` until then, and
     * for good when there is none — the derived badge underneath is what the
     * row shows in both cases (ADR-0021).
     */
    avatarUrl: string | null;
    /** Set when this row is a stash rather than a commit on a branch. */
    stash: StashEntry | undefined;
    /** The query to mark in the subject; empty when nothing is searched. */
    search: string;
  }): ReactNode {
  // A stash says what was set aside, not what git named the bookkeeping commit
  // ("On main: …"), and it is not attributed to anyone: it is not on a branch
  // and nobody authored it in the sense the column means.
  const subject =
    stash !== undefined
      ? stashRowLabel(stash)
      : commit.subject === ''
        ? '(no subject)'
        : commit.subject;
  const relative = formatRelativeDate(commit.authorDate, new Date());
  // Where the checkout stands. Unlike the selection, which follows the mouse,
  // this is a fact about the repository, so the row keeps the mark even while
  // the user reads some other commit.
  const current = checkedOutBranch(commit.refs);
  const atHead = isHeadRow(commit.refs);
  const store = useStore();
  const busy = useAppState(isBusy);
  const branches = useAppState((state) => state.branches);
  // What a double click on the row switches to: a local branch drawn on it,
  // never the bare commit (ADR-0061). A stash row has no branch to offer. A
  // row with only a remote-tracking branch goes to the local branch that
  // stands for it, moved forward to here (ADR-0062).
  const switchesTo = stash === undefined ? rowSwitchesTo(commit.refs) : null;
  const remoteSwitch =
    stash !== undefined || switchesTo !== null
      ? null
      : remoteSwitchFor(
          commit.refs,
          commit.oid,
          branches.state === 'ready' ? branches.value : null,
        );
  return (
    <RowButton
      index={index}
      selected={selected}
      head={atHead}
      tabbable={tabbable}
      dimmed={dimmed}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
      dragOid={commit.oid}
      dropHere={dropHere}
      {...(switchesTo !== null
        ? {
            onDoubleClick: () => {
              if (busy) return;
              // `switchTo` goes through `git switch`, so a dirty working tree is
              // a refusal from git rather than an overwrite.
              void switchTo(store, switchesTo);
            },
          }
        : remoteSwitch !== null
          ? {
              onDoubleClick: () => {
                if (busy) return;
                void switchToRemote(store, remoteSwitch);
              },
            }
          : {})}
      label={
        // Dimming is only visible; a listener hears which rows matched.
        search !== '' && dimmed !== true
          ? `${rowLabel(commit, subject, relative, stash)}, matches the search`
          : rowLabel(commit, subject, relative, stash)
      }
    >
      <span className={styles.columnRefs}>
        {stash !== undefined && (
          <span
            className={`${styles.ref} ${styles.refStash}`}
            data-ref-kind="stash"
            title={`stash ${stash.ref}`}
          >
            {stash.ref}
          </span>
        )}
        {commit.refs.map((ref) =>
          isRedundantHeadChip(ref, current) ? null : (
            <RefChip
              key={`${ref.kind}:${ref.name}`}
              commitRef={ref}
              oid={commit.oid}
              current={isCurrentChip(ref, current)}
            />
          ),
        )}
      </span>
      <span className={styles.columnGraph}>
        {graphRow !== undefined && (
          <GraphCell
            row={graphRow}
            laneCount={laneCount}
            rowHeight={ROW_HEIGHT}
            author={{ name: commit.authorName, email: commit.authorEmail }}
            avatarUrl={avatarUrl}
            stash={stash !== undefined}
          />
        )}
      </span>
      <span
        className={
          stash === undefined
            ? styles.columnSubject
            : `${styles.columnSubject} ${styles.stashSubject}`
        }
      >
        {search === ''
          ? subject
          : splitMatches(subject, search).map((part, at) =>
              part.match ? (
                <mark key={at} className={styles.findMark}>
                  {part.text}
                </mark>
              ) : (
                part.text
              ),
            )}
      </span>
      <span className={styles.columnAuthor}>
        {stash === undefined ? commit.authorName : ''}
      </span>
      <span className={styles.columnOid}>{commit.shortOid}</span>
      <time
        className={styles.columnDate}
        dateTime={commit.authorDate}
        title={formatAbsoluteDate(commit.authorDate)}
      >
        {relative}
      </time>
    </RowButton>
  );
}

/**
 * Rows are visually dense and abbreviated, so they carry an explicit label:
 * without one the accessible name is the run-together text of every column.
 */
function rowLabel(
  commit: Commit,
  subject: string,
  relative: string,
  stash?: StashEntry,
): string {
  const current = checkedOutBranch(commit.refs);
  const named = commit.refs
    .filter((ref) => !isRedundantHeadChip(ref, current))
    .map(
      (ref) =>
        `${isCurrentChip(ref, current) ? 'checked out ' : ''}${REF_LABEL[ref.kind]} ${ref.name}`,
    );
  const refs = named.length === 0 ? '' : `, ${named.join(', ')}`;
  // The word "stash" leads, because it is the thing a listener most needs to
  // know before the actions on this row make sense.
  if (stash !== undefined) return `stash ${stash.ref}, ${subject}, ${relative}`;
  return `${commit.shortOid} ${subject}, ${commit.authorName}, ${relative}${refs}`;
}

function RowButton({
  index,
  selected,
  head = false,
  tabbable,
  dimmed = false,
  onSelect,
  onContextMenu,
  onDoubleClick,
  dragOid,
  dropHere = false,
  label,
  children,
}: RowProps &
  Partial<MenuRowProps> & {
    /** The row HEAD is on; tinted even when the selection is elsewhere. */
    head?: boolean;
    /** Set on rows a double click does something to (a branch switch). */
    onDoubleClick?: () => void;
    /**
     * Set on rows that can be picked up and dropped on one another; the oid is
     * what the list reads back off the element at both ends of the gesture.
     */
    dragOid?: string;
    /** A drag is over this row and a drop would open its menu. */
    dropHere?: boolean;
    label: string;
    children: ReactNode;
  }): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      className={rowClass(selected, head, dimmed)}
      style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
      data-index={index}
      data-head={head ? 'true' : undefined}
      data-drag-oid={dragOid}
      data-drop-row={dropHere ? 'true' : undefined}
      draggable={dragOid === undefined ? undefined : true}
      aria-current={selected ? 'true' : undefined}
      tabIndex={tabbable ? 0 : -1}
      onClick={() => onSelect(index, false)}
      {...(onContextMenu === undefined ? {} : { onContextMenu })}
      {...(onDoubleClick === undefined ? {} : { onDoubleClick })}
    >
      {children}
    </button>
  );
}

function rowClass(selected: boolean, head: boolean, dimmed: boolean): string {
  const classes = [styles.row];
  if (head) classes.push(styles.rowHead);
  if (selected) classes.push(styles.rowSelected);
  if (dimmed) classes.push(styles.rowDimmed);
  return classes.join(' ');
}

const REF_CHIP_CLASS: Record<RefKind, string | undefined> = {
  head: styles.refHead,
  branch: styles.refBranch,
  'remote-branch': styles.refRemote,
  tag: styles.refTag,
};

const REF_LABEL: Record<RefKind, string> = {
  head: 'HEAD',
  branch: 'branch',
  'remote-branch': 'remote branch',
  tag: 'tag',
};

/**
 * A row for another checkout's uncommitted work.
 *
 * It is not a commit and does not pretend to be one: no author, no sha, no
 * date. What it says is who has this commit checked out somewhere else, how
 * much is uncommitted over there, and the way to go and look.
 */
function WorktreeRow({
  worktree,
  graphRow,
  laneCount,
  index,
  selected,
  tabbable,
  dimmed,
  onSelect,
}: {
  worktree: WorktreeSummary;
  graphRow: GraphRow | undefined;
  laneCount: number;
} & RowProps): ReactNode {
  const changes = worktreeChangeSummary(worktree);
  const name = worktreeName(worktree);
  const where = worktree.branch ?? 'a detached HEAD';

  return (
    <RowButton
      index={index}
      selected={selected}
      tabbable={tabbable}
      dimmed={dimmed}
      onSelect={onSelect}
      label={`Worktree ${name}, on ${where}${changes === null ? '' : `, ${changes}`}`}
    >
      <span className={styles.columnRefs}>
        <span className={`${styles.ref} ${styles.refWorktree}`} title={worktree.path}>
          {name}
        </span>
      </span>
      <span className={styles.columnGraph}>
        {graphRow !== undefined && (
          <GraphCell
            row={graphRow}
            laneCount={laneCount}
            rowHeight={ROW_HEIGHT}
            author={{ name: '', email: '' }}
            avatarUrl={null}
            stash
          />
        )}
      </span>
      <span className={`${styles.columnSubject} ${styles.worktreeSubject}`}>
        <span className={styles.worktreeWip}>WIP</span>
        {changes === null ? (
          <span className={styles.worktreeCount} title={worktree.path}>
            could not be read
          </span>
        ) : (
          <>
            {worktree.changed !== null && worktree.changed > 0 && (
              <span className={styles.worktreeCount}>{worktree.changed} changed</span>
            )}
            {worktree.untracked !== null && worktree.untracked > 0 && (
              <span className={styles.worktreeAdded}>+{worktree.untracked} new</span>
            )}
            {worktree.changed === 0 && worktree.untracked === 0 && (
              <span className={styles.worktreeCount}>clean</span>
            )}
          </>
        )}
        {worktree.locked !== null && (
          <span
            className={styles.worktreeCount}
            title={
              worktree.locked.length === 0
                ? 'This worktree is locked.'
                : `Locked: ${worktree.locked}`
            }
          >
            locked
          </span>
        )}
        <span
          className={styles.worktreeOpen}
          role="button"
          tabIndex={-1}
          title={`Open ${worktree.path} in a tab`}
          onClick={(event) => {
            // The row underneath is a button too; without this the click is
            // also a row selection.
            event.stopPropagation();
            requestOpenRepository(worktree.path);
          }}
        >
          Open Worktree
        </span>
      </span>
      <span className={styles.columnAuthor} />
      <span className={styles.columnOid} />
      <span className={styles.columnDate} />
    </RowButton>
  );
}

/**
 * Whether double-clicking this chip switches to it.
 *
 * Local branches only, and not the one already checked out. A remote-tracking
 * chip is deliberately excluded: `git switch origin/main` detaches HEAD rather
 * than checking that branch out, and the thing a user means by it — create the
 * local branch that tracks it — is a ref this repository does not have yet.
 * That belongs to the refs panel's `RemoteRow`, which asks for the name first.
 * Tags and HEAD have nothing to switch to.
 *
 * Pure and exported so the one rule that decides whether a double click moves
 * somebody's working tree is asserted on its own.
 */
export function chipSwitchesOnDoubleClick(
  commitRef: CommitRef,
  current: boolean,
): boolean {
  return commitRef.kind === 'branch' && !current;
}

function RefChip({
  commitRef,
  oid,
  current = false,
}: {
  commitRef: CommitRef;
  /** Commit the chip is drawn on, so a click can name what it selected. */
  oid: string;
  /** The ref the working tree is on: it gets the ✓ and the brighter chip. */
  current?: boolean;
}): ReactNode {
  const store = useStore();
  const busy = useAppState(isBusy);
  const kind = REF_CHIP_CLASS[commitRef.kind];
  const isBranch = commitRef.kind === 'branch' || commitRef.kind === 'remote-branch';
  // A branch you are not on can be picked up; the branch you *are* on is where
  // it can be put down. Tags and HEAD take no part: neither end of a merge is
  // a thing you can name with them.
  const draggable = isBranch && !current;
  const dropTarget = commitRef.kind === 'branch' && current;
  const switches = chipSwitchesOnDoubleClick(commitRef, current);
  // Everything with a row in the panel on the left. `HEAD` has none — it is
  // where the checkout is, not a ref anybody selects — and it is folded into
  // the branch chip beside it anyway.
  const selects = isBranch || commitRef.kind === 'tag';
  return (
    <span
      className={
        current ? `${styles.ref} ${kind} ${styles.refCurrent}` : `${styles.ref} ${kind}`
      }
      data-ref-kind={commitRef.kind}
      data-ref-name={commitRef.name}
      data-current={current ? 'true' : undefined}
      data-drop-target={dropTarget ? 'true' : undefined}
      data-switches={switches ? 'true' : undefined}
      draggable={draggable ? true : undefined}
      // A chip that answers a click is a control, and says so — the same shape
      // the worktree row's "Open Worktree" span uses. It stays out of the tab
      // order (`-1`): it lives inside the row's button, and the selection it
      // makes is reachable from the refs panel's own row.
      {...(selects ? { role: 'button', tabIndex: -1 } : {})}
      {...(selects
        ? {
            onClick: (event: ReactMouseEvent<HTMLSpanElement>) => {
              // The row's own click selects the commit, but it cannot say which
              // of the refs on it was clicked — and several refs sitting on one
              // commit is the ordinary case, not the odd one. Selecting from
              // here carries the ref path, which is what lets the panel on the
              // left highlight the row the user actually pointed at: a branch,
              // a remote-tracking branch or a tag. Nothing on disk moves either
              // way.
              event.stopPropagation();
              void selectCommit(store, oid, refPath(commitRef.kind, commitRef.name));
            },
          }
        : {})}
      {...(switches
        ? {
            onDoubleClick: (event: ReactMouseEvent<HTMLSpanElement>) => {
              // The chip sits inside the row's button, whose click selects the
              // commit. Without this the switch and a selection race each other.
              event.stopPropagation();
              if (busy) return;
              // `switchTo` goes through `git switch`, so a dirty working tree is
              // a refusal from git rather than an overwrite — which is what
              // makes this safe to put on a gesture as cheap as a double click.
              void switchTo(store, commitRef.name);
            },
          }
        : {})}
      title={
        switches
          ? `${REF_LABEL[commitRef.kind]} ${commitRef.name} — click to select it in the list on the left, double-click to switch to it, or drag onto the checked-out branch to merge it in`
          : draggable
            ? `${REF_LABEL[commitRef.kind]} ${commitRef.name} — click to select it in the list on the left, or drag onto the checked-out branch to merge it in`
            : selects
              ? `${current ? 'checked out ' : ''}${REF_LABEL[commitRef.kind]} ${commitRef.name} — click to select it in the list on the left`
              : `${current ? 'checked out ' : ''}${REF_LABEL[commitRef.kind]} ${commitRef.name}`
      }
    >
      {current ? (
        <>
          <span className={styles.refCheck} aria-hidden="true">
            ✓
          </span>
          <span className={styles.refName}>{commitRef.name}</span>
        </>
      ) : (
        commitRef.name
      )}
    </span>
  );
}

/** Index of a commit's row, or -1 when the oid is not in the loaded page. */
function indexOfOid(commits: Commit[], oid: string): number {
  const found = commits.findIndex((commit) => commit.oid === oid);
  return found === -1 ? -1 : found + 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Scroll offset that brings `index` into view, moving as little as possible. */
function scrollOffsetFor(
  index: number,
  scrollTop: number,
  viewportHeight: number,
): number {
  const top = index * ROW_HEIGHT;
  if (top < scrollTop) return top;
  const bottom = top + ROW_HEIGHT;
  if (bottom > scrollTop + viewportHeight) return bottom - viewportHeight;
  return scrollTop;
}
