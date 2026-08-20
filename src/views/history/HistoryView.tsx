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
  type KeyboardEvent,
  type ReactNode,
  type UIEvent,
} from 'react';
import type { Commit, CommitRef, RefKind } from '../../git/types';
import { selectCommit } from '../../state/actions';
import { useAppState, useStore } from '../../state/hooks';
import type { Loadable } from '../../state/store';
import { formatAbsoluteDate, formatRelativeDate } from './relativeTime';
import { GraphCell } from './GraphCell';
import { buildGraph, type GraphRow } from './graph';
import styles from './history.module.css';

/** Height of one row in pixels; must match `.row` in the stylesheet. */
export const ROW_HEIGHT = 44;
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
  return (
    <section className={styles.panel} aria-label="History">
      <h2 className={styles.title}>History</h2>
      <Body commits={commits} />
    </section>
  );
}

function Body({ commits }: { commits: Loadable<Commit[]> }): ReactNode {
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
      return <CommitList commits={commits.value} />;
  }
}

function CommitList({ commits }: { commits: Commit[] }): ReactNode {
  const store = useStore();
  const selectedOid = useAppState((state) => state.selection.commitOid);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(FALLBACK_VIEWPORT_HEIGHT);
  /** Set by keyboard navigation only, so a mouse click never steals focus. */
  const focusSelected = useRef(false);

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
    const row = viewportRef.current?.querySelector<HTMLElement>(
      `[data-index="${selectedIndex}"]`,
    );
    row?.focus();
  });

  const select = useCallback(
    (index: number, viaKeyboard: boolean): void => {
      const target = clamp(index, 0, total - 1);
      const commit = target === 0 ? null : commits[target - 1];
      // Clamping keeps `target` in range, so this only guards against a list
      // that changed under us between render and event.
      if (target !== 0 && commit === undefined) return;
      if (viaKeyboard) {
        focusSelected.current = true;
        const next = scrollOffsetFor(target, scrollTop, viewportHeight);
        if (next !== scrollTop) {
          setScrollTop(next);
          if (viewportRef.current !== null) viewportRef.current.scrollTop = next;
        }
      }
      void selectCommit(
        store,
        commit === null || commit === undefined ? null : commit.oid,
      );
    },
    [commits, scrollTop, store, total, viewportHeight],
  );

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

  const rows: ReactNode[] = [];
  for (let index = first; index < last; index += 1) {
    const shared = {
      index,
      selected: index === selectedIndex,
      tabbable: index === tabbableIndex,
      onSelect: select,
    };
    if (index === 0) {
      rows.push(<WorkingTreeRow key="working-tree" {...shared} />);
      continue;
    }
    const commit = commits[index - 1];
    if (commit === undefined) continue;
    rows.push(
      <CommitRow
        key={commit.oid}
        commit={commit}
        graphRow={graph.rows[index - 1]}
        laneCount={graph.laneCount}
        {...shared}
      />,
    );
  }

  return (
    <div
      className={styles.viewport}
      ref={viewportRef}
      role="group"
      aria-label="Commits"
      onScroll={onScroll}
      onKeyDown={onKeyDown}
    >
      <div className={styles.spacer} style={{ height: total * ROW_HEIGHT }}>
        {rows}
      </div>
      {commits.length === 0 && (
        <p className={styles.notice}>No commits yet — this repository has no history.</p>
      )}
    </div>
  );
}

interface RowProps {
  index: number;
  selected: boolean;
  tabbable: boolean;
  onSelect: (index: number, viaKeyboard: boolean) => void;
}

function WorkingTreeRow({ index, selected, tabbable, onSelect }: RowProps): ReactNode {
  return (
    <RowButton
      index={index}
      selected={selected}
      tabbable={tabbable}
      onSelect={onSelect}
      label="Working tree, uncommitted changes"
    >
      <span className={styles.oid} aria-hidden="true">
        —
      </span>
      <span className={styles.subject}>Working tree</span>
      <span className={styles.author}>Uncommitted changes</span>
    </RowButton>
  );
}

function CommitRow({
  commit,
  graphRow,
  laneCount,
  index,
  selected,
  tabbable,
  onSelect,
}: RowProps & {
  commit: Commit;
  graphRow: GraphRow | undefined;
  laneCount: number;
}): ReactNode {
  const subject = commit.subject === '' ? '(no subject)' : commit.subject;
  const relative = formatRelativeDate(commit.authorDate, new Date());
  return (
    <RowButton
      index={index}
      selected={selected}
      tabbable={tabbable}
      onSelect={onSelect}
      label={rowLabel(commit, subject, relative)}
    >
      {graphRow !== undefined && (
        <GraphCell row={graphRow} laneCount={laneCount} rowHeight={ROW_HEIGHT} />
      )}
      <span className={styles.oid}>{commit.shortOid}</span>
      <span className={styles.subject}>{subject}</span>
      {commit.refs.length > 0 && (
        <span className={styles.refs}>
          {commit.refs.map((ref) => (
            <RefChip key={`${ref.kind}:${ref.name}`} commitRef={ref} />
          ))}
        </span>
      )}
      <span className={styles.author}>{commit.authorName}</span>
      <time
        className={styles.date}
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
function rowLabel(commit: Commit, subject: string, relative: string): string {
  const refs =
    commit.refs.length === 0
      ? ''
      : `, ${commit.refs.map((ref) => `${REF_LABEL[ref.kind]} ${ref.name}`).join(', ')}`;
  return `${commit.shortOid} ${subject}, ${commit.authorName}, ${relative}${refs}`;
}

function RowButton({
  index,
  selected,
  tabbable,
  onSelect,
  label,
  children,
}: RowProps & { label: string; children: ReactNode }): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      className={selected ? `${styles.row} ${styles.rowSelected}` : styles.row}
      style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
      data-index={index}
      aria-current={selected ? 'true' : undefined}
      tabIndex={tabbable ? 0 : -1}
      onClick={() => onSelect(index, false)}
    >
      {children}
    </button>
  );
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

function RefChip({ commitRef }: { commitRef: CommitRef }): ReactNode {
  return (
    <span
      className={`${styles.ref} ${REF_CHIP_CLASS[commitRef.kind]}`}
      data-ref-kind={commitRef.kind}
      title={`${REF_LABEL[commitRef.kind]} ${commitRef.name}`}
    >
      {commitRef.name}
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
