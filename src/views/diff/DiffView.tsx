/**
 * Read-only diff panel.
 *
 * The panel never renders a blank body: every shape git can hand us — binary,
 * conflicted, mode-only, pure rename, empty new file — gets a sentence saying
 * what it is. A blank area would read as "no changes", and a user who trusts
 * that reading can stage or discard something they never actually saw.
 *
 * One file is on screen at a time. It used to mount every file's diff when no
 * path was selected, which is the state every commit click lands in — so
 * walking the history of a repository where commits touch hundreds of files
 * meant building hundreds of file blocks per arrow key, and the window locked
 * up between commits. The list on the left is the navigation; the body is
 * whichever file it points at, and nothing else exists in the DOM.
 */

import {
  memo,
  useCallback,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { LAYOUT_BOUNDS, type FileListMode } from '../../config/schema';
import type { DiffLine, FileDiff } from '../../git/types';
import { discardHunk, stageHunks } from '../../state/actions';
import { useAppState, useStore } from '../../state/hooks';
import { isBusy } from '../../state/store';
import { Splitter } from '../shell/Splitter';
import { edgeHandlers, rememberConfig, useLayout } from '../shell/useLayout';
import { FileEditor } from './FileEditor';
import { buildFileTree, type TreeNode } from './fileTree';
import {
  discardHunkQuestion,
  hunkActionBlocker,
  hunkActions,
  type HunkAction,
} from './hunkActions';
import styles from './DiffView.module.css';
import {
  CHANGE_KIND_LABELS,
  DIFF_SIDE_LABELS,
  displayPath,
  emptyBodyReason,
  LINE_KIND_LABELS,
  LINE_MARKERS,
} from './labels';
import {
  planFiles,
  REVEAL_CHUNK,
  sliceHunks,
  type FilePlan,
  type HunkSlice,
} from './renderPlan';

const NO_FILES: readonly FileDiff[] = [];
const NO_REVEALS: ReadonlyMap<string, number> = new Map();

/**
 * The user's "show me more of this file" clicks, remembered per file key.
 *
 * Stored *with* the file array they were made against, so a new diff arriving
 * — another commit, a refresh — starts from a clean slate on the very render
 * that shows it. Deriving during render instead of resetting in an effect
 * means no frame ever shows the previous diff's reveals.
 */
interface Reveals {
  for: readonly FileDiff[];
  map: ReadonlyMap<string, number>;
}

/** Diff panel for the current selection. Reads the store, writes only selection. */
export function DiffView(): ReactNode {
  const diff = useAppState((state) => state.diff);
  const selectedPath = useAppState((state) => state.selection.path);
  // Only the working tree is editable: a commit's version of a file is history,
  // and there is nothing on disk to write it back to.
  const editable = useAppState((state) => state.selection.commitOid === null);
  // `git diff` reports nothing for an untracked file — there is no earlier
  // version — so a path selected from the working-tree panel can legitimately
  // be missing from this diff. The status is the only thing that can tell that
  // case apart from a stale selection.
  const untrackedPath = useAppState((state) => {
    const path = state.selection.path;
    if (path === null || state.status.state !== 'ready') return false;
    return state.status.value.entries.some(
      (entry) => entry.path === path && entry.worktree === 'untracked',
    );
  });
  const store = useStore();
  const [editing, setEditing] = useState<string | null>(null);
  const [reveals, setReveals] = useState<Reveals | null>(null);

  const files = diff.state === 'ready' ? diff.value : NO_FILES;

  const revealed = reveals !== null && reveals.for === files ? reveals.map : NO_REVEALS;
  // The whole point of the plan is that this is the only place the full diff
  // is traversed — once per diff or reveal, not once per render of every row.
  const plans = useMemo(() => planFiles(files, revealed), [files, revealed]);

  const onReveal = useCallback(
    (key: string, lines: number): void => {
      setReveals((current) => {
        const base = current !== null && current.for === files ? current.map : NO_REVEALS;
        const next = new Map(base);
        next.set(key, lines);
        return { for: files, map: next };
      });
    },
    [files],
  );

  const selectPath = (path: string | null): void => {
    store.dispatch({ type: 'selection/path', path });
  };

  /**
   * The file the body draws.
   *
   * Selecting a commit clears the path, so the ordinary state is "no file
   * picked" — and a panel that answers that with nothing would make every
   * commit in the history take two clicks to read. The first file stands in
   * until the user picks another. It is derived rather than dispatched: the
   * store keeps meaning "the user has chosen nothing", which is what lets the
   * next commit fall back to *its* first file instead of inheriting this one.
   */
  const activePath = selectedPath ?? plans[0]?.file.newPath ?? null;

  const config = useAppState((state) => state.config);
  const layout = useLayout();
  const setMode = (mode: FileListMode): void => {
    if (mode !== config.diffFileList) rememberConfig({ ...config, diffFileList: mode });
  };

  return (
    <section className={styles.panel} aria-label="Diff">
      {diff.state === 'idle' && (
        <Notice title="No diff to show">
          Select a commit or the working tree to see its changes.
        </Notice>
      )}

      {diff.state === 'loading' && (
        <Notice title="Loading diff…">Reading changes from git.</Notice>
      )}

      {diff.state === 'error' && <DiffError message={diff.message} kind={diff.kind} />}

      {diff.state === 'ready' && diff.value.length === 0 && (
        <Notice title="No changes">Nothing differs in this selection.</Notice>
      )}

      {diff.state === 'ready' && diff.value.length > 0 && (
        <div
          className={styles.body}
          style={
            {
              '--files-width': `${String(layout.layout.diffFilesWidth)}px`,
            } as CSSProperties
          }
        >
          <FileList
            plans={plans}
            activePath={activePath}
            mode={config.diffFileList}
            onMode={setMode}
            onSelect={selectPath}
          />
          <Splitter
            orientation="vertical"
            label="Resize the file list"
            value={layout.layout.diffFilesWidth}
            min={LAYOUT_BOUNDS.diffFilesWidth.min}
            max={LAYOUT_BOUNDS.diffFilesWidth.max}
            {...edgeHandlers(
              layout,
              (current) => current.diffFilesWidth,
              (current, value) => ({ ...current, diffFilesWidth: value }),
            )}
          />
          <FileDiffs
            plans={plans}
            activePath={activePath}
            selectedPath={selectedPath}
            editable={editable}
            editing={editing}
            onEdit={setEditing}
            onReveal={onReveal}
            untracked={untrackedPath}
          />
        </div>
      )}
    </section>
  );
}

function DiffError({ message, kind }: { message: string; kind?: string }): ReactNode {
  if (kind === 'undecodable-output') {
    return (
      <Notice title="Diff cannot be shown safely" tone="error">
        The file&apos;s bytes are not valid UTF-8, so this diff cannot be decoded without
        corrupting it. Krakenless will not show a mangled diff you might act on. Details:{' '}
        {message}
      </Notice>
    );
  }
  return (
    <Notice title="Could not load the diff" tone="error">
      {message}
    </Notice>
  );
}

function Notice({
  title,
  tone = 'neutral',
  children,
}: {
  title: string;
  tone?: 'neutral' | 'error';
  children: ReactNode;
}): ReactNode {
  return (
    <div
      className={
        tone === 'error' ? `${styles.notice} ${styles.noticeError}` : styles.notice
      }
      role={tone === 'error' ? 'alert' : undefined}
    >
      <strong className={styles.noticeTitle}>{title}</strong>
      <p className={styles.noticeText}>{children}</p>
    </div>
  );
}

const FileList = memo(function FileList({
  plans,
  activePath,
  mode,
  onMode,
  onSelect,
}: {
  plans: FilePlan[];
  /** The file the body is showing — which is what the list marks as current. */
  activePath: string | null;
  mode: FileListMode;
  onMode: (mode: FileListMode) => void;
  onSelect: (path: string | null) => void;
}): ReactNode {
  const tree = useMemo(
    () => (mode === 'tree' ? buildFileTree(plans) : []),
    [mode, plans],
  );
  // Folded directories, by path. Local to the list: which folders are open is
  // a property of *this* diff, and the next commit starts with all of them
  // open, which is the state that shows the most.
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const toggleFolded = (path: string): void => {
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <nav className={styles.files} aria-label="Changed files">
      <div className={styles.fileHead}>
        {/*
          A count, not a control. "All files" used to be the first row here, and
          choosing it mounted every file's diff at once — the thing that made
          walking the history of a large commit unusable.
        */}
        <p className={styles.fileCount}>
          {plans.length === 1 ? '1 changed file' : `${plans.length} changed files`}
        </p>
        <div className={styles.modeToggle} role="group" aria-label="File list layout">
          <button
            type="button"
            className={styles.modeButton}
            aria-pressed={mode === 'flat'}
            title="Show each file with its full path"
            onClick={() => onMode('flat')}
          >
            List
          </button>
          <button
            type="button"
            className={styles.modeButton}
            aria-pressed={mode === 'tree'}
            title="Group files by directory"
            onClick={() => onMode('tree')}
          >
            Tree
          </button>
        </div>
      </div>
      {mode === 'tree' ? (
        <ul className={styles.treeList} role="tree">
          {tree.map((node) => (
            <TreeRow
              key={node.kind === 'dir' ? `dir:${node.path}` : node.plan.key}
              node={node}
              activePath={activePath}
              folded={folded}
              onToggle={toggleFolded}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : (
        <ul className={styles.fileList}>
          {plans.map((plan) => (
            <li key={plan.key}>
              <FileRow
                plan={plan}
                label={displayPath(plan.file)}
                activePath={activePath}
                onSelect={onSelect}
              />
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
});

/**
 * One file in the list, in either shape.
 *
 * The `title` carries the full path in both: a list narrow enough to clip the
 * name is the ordinary case for a deep path, and the tooltip is what says the
 * rest without the user having to drag the edge first.
 */
function FileRow({
  plan,
  label,
  activePath,
  onSelect,
}: {
  plan: FilePlan;
  /** What the row shows: the full path in the list, the file name in the tree. */
  label: string;
  activePath: string | null;
  onSelect: (path: string | null) => void;
}): ReactNode {
  const { file, added, deleted } = plan;
  return (
    <button
      type="button"
      className={styles.fileButton}
      aria-current={activePath === file.newPath ? 'true' : undefined}
      title={displayPath(file)}
      onClick={() => onSelect(file.newPath)}
    >
      <span className={styles.filePath}>{label}</span>
      <span className={styles.fileKind}>{CHANGE_KIND_LABELS[file.kind]}</span>
      {/*
        The worktree and cached diffs are concatenated, so the same path
        can be listed twice. Without this the two rows are identical and
        the user cannot tell which one their buttons will act on.
      */}
      <span className={styles.fileSide}>{DIFF_SIDE_LABELS[file.side]}</span>
      <span className={styles.counts}>
        <span className={styles.added}>{`+${added}`}</span>
        <span className={styles.deleted}>{`-${deleted}`}</span>
      </span>
    </button>
  );
}

function TreeRow({
  node,
  activePath,
  folded,
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  activePath: string | null;
  folded: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string | null) => void;
}): ReactNode {
  if (node.kind === 'file') {
    return (
      <li role="treeitem" aria-selected={activePath === node.plan.file.newPath}>
        <FileRow
          plan={node.plan}
          label={node.name}
          activePath={activePath}
          onSelect={onSelect}
        />
      </li>
    );
  }
  const open = !folded.has(node.path);
  return (
    <li role="treeitem" aria-expanded={open} aria-selected={false}>
      <button
        type="button"
        className={styles.treeDir}
        aria-expanded={open}
        title={node.path}
        onClick={() => onToggle(node.path)}
      >
        <span className={styles.treeChevron} aria-hidden="true">
          ▾
        </span>
        <span className={styles.treeDirName}>{node.name}</span>
      </button>
      {open && (
        <ul className={styles.treeChildren} role="group">
          {node.children.map((child) => (
            <TreeRow
              key={child.kind === 'dir' ? `dir:${child.path}` : child.plan.key}
              node={child}
              activePath={activePath}
              folded={folded}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function FileDiffs({
  plans,
  activePath,
  selectedPath,
  editable,
  editing,
  onEdit,
  onReveal,
  untracked,
}: {
  plans: FilePlan[];
  /** The file to draw: the selected one, or the first when none was picked. */
  activePath: string | null;
  /** What the user actually chose; `null` when they chose nothing. */
  selectedPath: string | null;
  editable: boolean;
  editing: string | null;
  onEdit: (path: string | null) => void;
  onReveal: (key: string, lines: number) => void;
  /** True when the selected path is a file git does not track yet. */
  untracked: boolean;
}): ReactNode {
  // The same path can appear twice — the worktree and the staged diff are
  // concatenated — and both belong on screen when it is the file being read.
  const shown = plans.filter((plan) => plan.file.newPath === activePath);

  if (shown.length === 0) {
    return (
      <div className={styles.content}>
        <Notice title={untracked ? 'Nothing to diff yet' : 'File not in this diff'}>
          {untracked
            ? // Reachable from the working-tree panel, where untracked files are
              // listed next to modified ones and look equally clickable. Git has
              // no previous version to compare against, so `git diff` says
              // nothing about them — which is a different problem from "wrong
              // selection", and needs a different next step.
              `"${selectedPath ?? ''}" is not tracked by git yet, so there is no earlier version to compare it against. Stage it to see its contents as a diff.`
            : `"${selectedPath ?? ''}" is not part of the current selection. Pick a file from the list.`}
        </Notice>
      </div>
    );
  }

  return (
    <div className={styles.content}>
      {shown.map((plan) => (
        <FileDiffBlock
          key={plan.key}
          plan={plan}
          editable={editable}
          editing={editing === plan.file.newPath}
          onEdit={onEdit}
          onReveal={onReveal}
        />
      ))}
    </div>
  );
}

const FileDiffBlock = memo(function FileDiffBlock({
  plan,
  editable,
  editing,
  onEdit,
  onReveal,
}: {
  plan: FilePlan;
  editable: boolean;
  editing: boolean;
  onEdit: (path: string | null) => void;
  onReveal: (key: string, lines: number) => void;
}): ReactNode {
  const { file, key, total, visible } = plan;
  const note = emptyBodyReason(file);
  // A deleted file has nothing on disk to open; the rest are edited at their
  // current path, which for a rename is the new one.
  const canEdit = editable && file.kind !== 'deleted';
  // Said once above the hunks rather than repeated on every one of them, and
  // only when there are hunks a user would otherwise expect buttons on.
  const blocker = file.side === 'commit' ? null : hunkActionBlocker(file);
  // Sliced once per (file, visible) — never per render, and never mutating the
  // hunks themselves: the slice keeps the original hunk object for actions.
  const slices = useMemo(() => sliceHunks(file, visible), [file, visible]);
  const hidden = total - visible;

  return (
    <article className={styles.file} aria-label={displayPath(file)}>
      <header className={styles.fileHeader}>
        <span className={styles.filePath}>{displayPath(file)}</span>
        <span className={styles.fileKind}>{CHANGE_KIND_LABELS[file.kind]}</span>
        <span className={styles.fileSide}>{DIFF_SIDE_LABELS[file.side]}</span>
        {canEdit && !editing && (
          <button
            type="button"
            className={styles.editButton}
            onClick={() => onEdit(file.newPath)}
          >
            Edit
          </button>
        )}
      </header>

      {editing ? (
        <FileEditor key={file.newPath} path={file.newPath} onClose={() => onEdit(null)} />
      ) : note === null ? (
        <>
          {blocker !== null && slices.length > 0 && (
            <p className={styles.fileNote}>{blocker}</p>
          )}
          {slices.map((slice, index) => (
            <HunkBlock key={index} file={file} slice={slice} />
          ))}
          {hidden > 0 && (
            <div className={styles.fileNote}>
              {/*
                Only its own size can collapse a file now. The panel-wide budget
                that used to be the other reason went with the all-files body.
              */}
              {visible > 0
                ? `${hidden.toLocaleString('en-US')} more lines are not rendered yet.`
                : `This diff is large (${total.toLocaleString('en-US')} lines), so it is not rendered yet.`}{' '}
              <button
                type="button"
                className={styles.hunkAction}
                onClick={() => onReveal(key, visible + REVEAL_CHUNK)}
              >
                {`Show ${Math.min(hidden, REVEAL_CHUNK).toLocaleString('en-US')} ${visible === 0 ? 'lines' : 'more lines'} of ${displayPath(file)}`}
              </button>
            </div>
          )}
        </>
      ) : (
        <p className={styles.fileNote}>{note}</p>
      )}
    </article>
  );
});

const HunkBlock = memo(function HunkBlock({
  file,
  slice,
}: {
  file: FileDiff;
  slice: HunkSlice;
}): ReactNode {
  const hunk = slice.hunk;
  const store = useStore();
  const busy = useAppState(isBusy);
  const [confirming, setConfirming] = useState(false);
  // A truncated hunk gets no action buttons: they act on the *whole* hunk —
  // slicing is display-only — and staging or discarding lines the user has
  // not seen is exactly what this panel promises never to invite. The note
  // below says how to get the buttons back.
  const truncated = slice.hidden > 0;
  const actions = truncated ? [] : hunkActions(file);
  const withheld = truncated && hunkActions(file).length > 0;

  const run = (action: HunkAction): void => {
    if (action === 'discard') {
      setConfirming(true);
      return;
    }
    void stageHunks(store, file, [hunk], { reverse: action === 'unstage' });
  };

  return (
    <div className={styles.hunk}>
      <div className={styles.hunkHeader}>
        <span className={styles.hunkRange}>{hunk.header}</span>
        {withheld && (
          <span className={styles.fileNote}>
            {`Only ${slice.lines.length.toLocaleString('en-US')} of this hunk's ${hunk.lines.length.toLocaleString('en-US')} lines are shown. Show the rest to stage or discard it.`}
          </span>
        )}
        {actions.length > 0 && (
          <span className={styles.hunkActions}>
            {actions.map((spec) => (
              <button
                key={spec.action}
                type="button"
                className={spec.danger ? styles.hunkDanger : styles.hunkAction}
                disabled={busy}
                // The header alone does not say which file, and the same hunk
                // range exists in every other file on screen.
                aria-label={`${spec.label} of ${file.newPath}, ${hunk.header}`}
                onClick={() => {
                  run(spec.action);
                }}
              >
                {spec.label}
              </button>
            ))}
          </span>
        )}
      </div>

      {confirming && (
        <ConfirmDiscardHunk
          question={discardHunkQuestion(file.newPath, hunk.header)}
          busy={busy}
          onCancel={() => {
            setConfirming(false);
          }}
          onConfirm={() => {
            setConfirming(false);
            void discardHunk(
              store,
              file,
              [hunk],
              discardHunkQuestion(file.newPath, hunk.header),
            );
          }}
        />
      )}
      <LineRows lines={slice.lines} />
    </div>
  );
});

/**
 * The line rows, split out and memoized: they are the overwhelming majority
 * of the panel's DOM, and nothing about them depends on `busy` or any other
 * store state — so a busy flip must re-render hunk *headers*, never thousands
 * of line rows. The `lines` array identity is stable per (file, visible)
 * thanks to the memoized slice.
 */
const LineRows = memo(function LineRows({
  lines,
}: {
  lines: readonly DiffLine[];
}): ReactNode {
  return (
    <div className={styles.lines}>
      {lines.map((line, index) => (
        <div
          key={index}
          className={`${styles.line} ${lineClass(line.kind)}`}
          data-kind={line.kind}
          data-old-line={line.oldLine ?? ''}
          data-new-line={line.newLine ?? ''}
        >
          <span className={styles.srOnly}>{`${LINE_KIND_LABELS[line.kind]}: `}</span>
          <span className={styles.lineNumber} data-side="old">
            {line.oldLine ?? ''}
          </span>
          <span className={styles.lineNumber} data-side="new">
            {line.newLine ?? ''}
          </span>
          <span className={styles.marker} aria-hidden="true">
            {LINE_MARKERS[line.kind]}
          </span>
          <span className={styles.lineText}>{line.text}</span>
        </div>
      ))}
    </div>
  );
});

/**
 * The one destructive control in this panel, so it asks in full sentences and
 * defaults to Cancel. Inline rather than a modal: the hunk it is about has to
 * stay on screen while the question is being read.
 */
function ConfirmDiscardHunk({
  question,
  busy,
  onCancel,
  onConfirm,
}: {
  question: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactNode {
  return (
    <div className={styles.confirm} role="alertdialog" aria-label="Confirm discard hunk">
      <p className={styles.confirmText}>{question}</p>
      <div className={styles.confirmButtons}>
        <button type="button" className={styles.hunkAction} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className={styles.hunkDanger}
          disabled={busy}
          onClick={onConfirm}
        >
          Discard hunk
        </button>
      </div>
    </div>
  );
}

function lineClass(kind: DiffLine['kind']): string | undefined {
  switch (kind) {
    case 'added':
      return styles.lineAdded;
    case 'deleted':
      return styles.lineDeleted;
    case 'no-newline':
      return styles.lineNoNewline;
    case 'context':
      return styles.lineContext;
  }
}
