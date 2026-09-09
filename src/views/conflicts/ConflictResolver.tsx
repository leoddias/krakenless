/**
 * The conflict resolution screen: both sides, the choices, and the result.
 *
 * Four things about it are deliberate.
 *
 * **Only the real conflicts are questions.** The screen reads all three index
 * stages, and a run of lines only one side moved away from the common ancestor
 * is that side's edit — it is applied, ticked and labelled `auto`, not put to
 * the user as a checkbox next to the words "nothing on this side". What is left
 * undecided is what both sides changed, which is what git means by a conflict.
 * The screen opens standing on the first of those.
 *
 * **The result is not a preview.** The Output pane is produced by the same
 * `assemble` the Save button writes, so what the user reads is what lands on
 * disk. A pane that approximated the outcome would be worse than none. Its
 * colours come from the same walk (`assembleSegments`, which `assemble` is a
 * flattening of), so a line tinted as "taken from your commit" is that line,
 * not a second guess at where it came from — and because each run carries the
 * address of the lines it came from, a run can be **edited in place**: the text
 * goes back into the block, and `assemble` still builds the file from blocks.
 * The alternative — a free-text box holding the whole result — would fork the
 * model in two and lose every colour on the way.
 *
 * **Nothing is chosen by the screen that the merge cannot justify.** A block
 * both sides changed contributes no lines until somebody picks, so a
 * half-finished resolution visibly has a hole in it and Save stays disabled.
 *
 * **The sides come from the index, not from the file on disk.** The marked-up
 * working copy is ambiguous — a file may legitimately contain a line of seven
 * angle brackets — while stages 1, 2 and 3 are exactly what each side had.
 *
 * The two sides are one grid, not two scrolling columns. Each block occupies
 * the same grid row on both sides, so the halves of a decision are always level
 * with each other, and the whole thing is a single scroller: one wheel, one
 * horizontal scrollbar, both sides moving together. Two independent scrollers
 * meant lining the sides up by hand, and a long line had to be scrolled twice
 * to be read once. Above the grid, Previous and Next walk the conflicts
 * themselves — and walk past the ones the merge already answered.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { readConflictSides, type ConflictSides } from '../../git/conflict';
import { resolveConflict } from '../../state/actions';
import { useAppState, useStore } from '../../state/hooks';
import { isBusy } from '../../state/store';
import { Splitter } from '../shell/Splitter';
import { trapTab } from '../shell/trapTab';
import {
  assemble,
  assembleSegments,
  autoCount,
  buildBlocks,
  buildMergedBlocks,
  choose,
  chooseAll,
  conflictCount,
  editLines,
  endsWithNewline,
  navigable,
  toLines,
  tooLargeToCompare,
  undecided,
  type Block,
  type BlockPart,
  type Choice,
  type OutputSegment,
} from './resolve';
import styles from './ConflictResolver.module.css';

/**
 * What each side is called, from the operation in progress.
 *
 * This is not cosmetic. During a merge, "ours" is the branch you are on. During
 * a **rebase**, git replays your commits onto the other branch, so stage 2 is
 * the branch being rebased *onto* and stage 3 is your own commit — the labels
 * swap round, and a screen that says "yours" over the wrong pane will get
 * somebody's work thrown away.
 */
export function sideLabels(kind: string | null): { ours: string; theirs: string } {
  if (kind === 'rebase') {
    return { ours: 'Upstream (rebased onto)', theirs: 'Your commit (being replayed)' };
  }
  if (kind === 'cherry-pick' || kind === 'revert') {
    return { ours: 'Current branch', theirs: `Commit being applied` };
  }
  return { ours: 'Ours (current branch)', theirs: 'Theirs (incoming)' };
}

/** How much of the screen the Output may be dragged to. */
const SHARE_BOUNDS = { min: 12, max: 80 } as const;

function clampShare(share: number): number {
  return Math.min(Math.max(share, SHARE_BOUNDS.min), SHARE_BOUNDS.max);
}

/**
 * The blocks for a conflicted file.
 *
 * With a common ancestor this is a three-way merge, which is what lets a
 * one-sided change be applied rather than asked about. Without one — an add/add
 * conflict, where neither side inherited the file — there is nothing to judge
 * the two sides against, so every difference stays a question.
 */
function blocksFor(sides: ConflictSides): Block[] {
  const ours = toLines(sides.ours.text);
  const theirs = toLines(sides.theirs.text);
  if (!sides.base.present) return buildBlocks(ours, theirs);
  return buildMergedBlocks(toLines(sides.base.text), ours, theirs);
}

type Loaded =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'too-large' }
  | { state: 'ready'; sides: ConflictSides; blocks: Block[]; trailingNewline: boolean };

export function ConflictResolver(): ReactNode {
  const store = useStore();
  const path = useAppState((state) => state.resolving);
  const operation = useAppState((state) => state.operation);
  const busy = useAppState(isBusy);
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });

  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    setLoaded({ state: 'loading' });

    void (async () => {
      const root = store.getState().repo;
      if (root.state !== 'ready') return;
      try {
        const sides = await readConflictSides(root.value.root, path);
        if (cancelled) return;
        if (tooLargeToCompare(sides.ours.text, sides.theirs.text, sides.base.text)) {
          setLoaded({ state: 'too-large' });
          return;
        }
        setLoaded({
          state: 'ready',
          sides,
          blocks: blocksFor(sides),
          // Taken from whichever side has the file: adding a trailing newline
          // that was never there is a diff on a line nobody touched.
          trailingNewline:
            endsWithNewline(sides.ours.text) || endsWithNewline(sides.theirs.text),
        });
      } catch (error) {
        if (!cancelled) {
          setLoaded({
            state: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path, store]);

  if (path === null) return null;

  const close = (): void => store.dispatch({ type: 'resolve/closed' });
  const labels = sideLabels(operation.kind);

  return (
    <div className={styles.backdrop} role="presentation">
      <section
        className={styles.screen}
        role="dialog"
        aria-modal="true"
        aria-label={`Resolve ${path}`}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) {
            event.stopPropagation();
            close();
            return;
          }
          trapTab(event);
        }}
      >
        <header className={styles.header}>
          <code className={styles.path}>{path}</code>
          {loaded.state === 'ready' && <Tally blocks={loaded.blocks} />}
          <button type="button" className={styles.close} onClick={close}>
            Close
          </button>
        </header>

        {loaded.state === 'loading' && (
          <p className={styles.notice}>Reading all three sides of the conflict…</p>
        )}

        {loaded.state === 'error' && (
          <p className={styles.notice} role="alert">
            The conflicting versions could not be read: {loaded.message}
          </p>
        )}

        {loaded.state === 'too-large' && (
          <p className={styles.notice} role="alert">
            This file is too large to compare line by line here. Use your merge tool or an
            editor, then stage it — the block view would take longer to build than the
            window would survive.
          </p>
        )}

        {loaded.state === 'ready' && (
          <ResolverBody
            key={path}
            path={path}
            labels={labels}
            loaded={loaded}
            busy={busy}
            onBlocks={(blocks) => setLoaded({ ...loaded, blocks })}
            onDone={close}
          />
        )}
      </section>
    </div>
  );
}

/**
 * The count in the title bar.
 *
 * It says what is left *and* what was decided for the user, because a screen
 * that silently applied thirty one-sided changes and then said "0 of 2 left"
 * would be hiding most of what it did.
 */
function Tally({ blocks }: { blocks: Block[] }): ReactNode {
  const left = undecided(blocks).length;
  const total = conflictCount(blocks);
  const auto = autoCount(blocks);
  return (
    <span className={styles.count}>
      {left} of {total} left
      {auto > 0 && ` · ${String(auto)} merged automatically`}
    </span>
  );
}

function ResolverBody({
  path,
  labels,
  loaded,
  busy,
  onBlocks,
  onDone,
}: {
  path: string;
  labels: { ours: string; theirs: string };
  loaded: Extract<Loaded, { state: 'ready' }>;
  busy: boolean;
  onBlocks: (blocks: Block[]) => void;
  onDone: () => void;
}): ReactNode {
  const store = useStore();
  const { blocks, trailingNewline } = loaded;
  const left = undecided(blocks).length;
  const total = conflictCount(blocks);

  // Where the panes scroll, and which conflict the navigation is standing on.
  // The id is kept rather than the position, so a re-render after a choice
  // cannot move the highlight onto a different block.
  const panes = useRef<HTMLDivElement | null>(null);
  const output = useRef<HTMLPreElement | null>(null);
  // Set while one scroller is being moved to follow the other, so the scroll
  // event that causes does not bounce straight back and fight the user.
  const following = useRef(false);
  const [currentId, setCurrentId] = useState<number | null>(null);
  /** The run being edited, as `blockIndex:part`, and the text in the box. */
  const [editingAt, setEditingAt] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /**
   * Share of the screen the Output takes, as a percentage.
   *
   * Kept here rather than in the config: it is the shape of one file's
   * resolution — a file whose conflicts are three lines each wants a different
   * split from one where they are forty — and settling it for every future
   * conflict is not what dragging this edge means.
   */
  const [outputShare, setOutputShare] = useState(34);
  const shareAtDragStart = useRef(34);
  const body = useRef<HTMLDivElement | null>(null);

  /** Turns a drag in pixels into a share of the height it was dragged across. */
  const dragOutput = (delta: number): void => {
    const height = body.current?.clientHeight ?? 0;
    if (height <= 0) return;
    // Dragging down makes the Output smaller, so the sign is inverted.
    setOutputShare(clampShare(shareAtDragStart.current - (delta / height) * 100));
  };

  /**
   * Scrolls `to` to the same *place in the file* as `from`.
   *
   * By proportion rather than by pixels, because the two are not the same
   * content: the output leaves out every block still undecided, so it is
   * shorter than the sides above it and cannot be tracked line for line. The
   * horizontal offset is copied straight across — that one really is the same
   * text, just in another box.
   */
  const follow = (from: HTMLElement | null, to: HTMLElement | null): void => {
    if (from === null || to === null || following.current) return;
    following.current = true;
    const fromMax = from.scrollHeight - from.clientHeight;
    const toMax = to.scrollHeight - to.clientHeight;
    to.scrollTop = fromMax <= 0 ? 0 : (from.scrollTop / fromMax) * toMax;
    to.scrollLeft = from.scrollLeft;
    // Released a frame later: the assignment above queues a scroll event that
    // has not been delivered yet.
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        following.current = false;
      });
    } else {
      following.current = false;
    }
  };

  /** Puts a block on screen in both halves of the grid and in the result. */
  const reveal = (id: number): void => {
    const target = panes.current?.querySelector(`[data-block="${String(id)}"]`);
    // Not in jsdom, and not worth a polyfill: the state is what the tests are
    // about, and the scroll is what a browser adds to it.
    target?.scrollIntoView?.({ block: 'center' });
    // The Output can be pointed at the exact lines instead of at a proportion
    // of the file — but only when the block has any: an undecided one, or one
    // where neither side was kept, is not down there at all.
    output.current
      ?.querySelector(`[data-block="${String(id)}"]`)
      ?.scrollIntoView?.({ block: 'center' });
  };

  const navIds = navigable(blocks).map((block) => block.id);
  const at = currentId === null ? -1 : navIds.indexOf(currentId);

  /**
   * Opening the screen already standing on the first conflict.
   *
   * Once, on mount: after that the position belongs to the user, and a file
   * whose every block was merged automatically has nothing to stand on. Run
   * here rather than at load so the rows exist to be scrolled to.
   */
  useEffect(() => {
    const first = navigable(loaded.blocks)[0];
    if (first === undefined) return;
    setCurrentId(first.id);
    reveal(first.id);
    // Mount only — `reveal` and the blocks change with every choice, and this
    // is about where the screen opens, not about where it goes afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Moves to the conflict `step` away and brings it into view.
   *
   * From nowhere, Next lands on the first conflict and Previous on the last,
   * which is what someone who has not started reading yet expects from either
   * button.
   */
  const jump = (step: number): void => {
    if (navIds.length === 0) return;
    const next =
      at === -1
        ? step > 0
          ? 0
          : navIds.length - 1
        : Math.min(Math.max(at + step, 0), navIds.length - 1);
    const id = navIds[next];
    if (id === undefined) return;
    setCurrentId(id);
    reveal(id);
  };

  /** Opens a run of the result for editing, with its current text in the box. */
  const startEditing = (segment: OutputSegment): void => {
    if (busy) return;
    setEditingAt(`${String(segment.blockIndex)}:${segment.part}`);
    setDraft(segment.lines.join('\n'));
  };

  /** Writes the typed text back into the block the run came from. */
  const commitEdit = (index: number, part: BlockPart): void => {
    setEditingAt(null);
    onBlocks(editLines(blocks, index, part, draft === '' ? [] : draft.split('\n')));
  };

  const save = (): void => {
    void resolveConflict(store, path, assemble(blocks, trailingNewline)).then((ok) => {
      if (ok) onDone();
    });
  };

  return (
    <>
      <div className={styles.bulk}>
        <button
          type="button"
          className={`${styles.action} ${styles.takeOurs}`}
          disabled={busy || total === 0}
          onClick={() => onBlocks(chooseAll(blocks, 'ours'))}
        >
          Take all from {labels.ours}
        </button>
        <button
          type="button"
          className={`${styles.action} ${styles.takeTheirs}`}
          disabled={busy || total === 0}
          onClick={() => onBlocks(chooseAll(blocks, 'theirs'))}
        >
          Take all from {labels.theirs}
        </button>
        {/*
          Both sides, every block, in ours-then-theirs order — the answer when
          two branches added different things and the file wants all of them.
          It is a real resolution, not a shortcut around deciding: `assemble`
          writes exactly these lines.
        */}
        <button
          type="button"
          className={styles.action}
          disabled={busy || total === 0}
          title="Keep both sides of every block, one after the other"
          onClick={() => onBlocks(chooseAll(blocks, 'both'))}
        >
          Take both, everywhere
        </button>

        {/*
          Between the two "take all" buttons and the panes, because it is about
          neither side: it walks the disagreements themselves.
        */}
        <div className={styles.nav}>
          <button
            type="button"
            className={styles.navButton}
            disabled={navIds.length === 0 || at === 0}
            title="Go to the previous conflicting block"
            onClick={() => jump(-1)}
          >
            ‹ Previous
          </button>
          <span className={styles.navCount} role="status">
            {navIds.length === 0
              ? 'nothing left to decide'
              : at === -1
                ? `${String(navIds.length)} conflict${navIds.length === 1 ? '' : 's'}`
                : `Conflict ${String(at + 1)} of ${String(navIds.length)}`}
          </span>
          <button
            type="button"
            className={styles.navButton}
            disabled={navIds.length === 0 || at === navIds.length - 1}
            title="Go to the next conflicting block"
            onClick={() => jump(1)}
          >
            Next ›
          </button>
        </div>
      </div>

      {/*
        One scroller for both sides. `ref` is here rather than on a pane because
        the panes are `display: contents` — they have no box of their own, which
        is what lets a block sit on the same grid row as its other half.
      */}
      <div className={styles.body} ref={body}>
        <div
          className={styles.panes}
          ref={panes}
          onScroll={() => follow(panes.current, output.current)}
        >
          <Side
            title={labels.ours}
            side="ours"
            column={1}
            blocks={blocks}
            busy={busy}
            currentId={currentId}
            onChoose={(id, choice) => onBlocks(choose(blocks, id, choice))}
          />
          <Side
            title={labels.theirs}
            side="theirs"
            column={2}
            blocks={blocks}
            busy={busy}
            currentId={currentId}
            onChoose={(id, choice) => onBlocks(choose(blocks, id, choice))}
          />
        </div>

        <Splitter
          orientation="horizontal"
          label="Resize the output"
          value={outputShare}
          min={SHARE_BOUNDS.min}
          max={SHARE_BOUNDS.max}
          onDragStart={() => {
            shareAtDragStart.current = outputShare;
          }}
          onDrag={dragOutput}
          onDragEnd={() => {
            shareAtDragStart.current = outputShare;
          }}
          onNudge={(delta) => {
            shareAtDragStart.current = outputShare;
            dragOutput(delta);
          }}
        />

        <section
          className={styles.output}
          aria-label="Output"
          style={{ flexBasis: `${String(outputShare)}%` }}
        >
          <header className={styles.outputHeader}>
            <h3 className={styles.outputTitle}>Output</h3>
            <span className={styles.hint}>double-click any run to edit it</span>
            <span className={styles.count}>
              {left === 0
                ? 'every block decided'
                : `${String(left)} block${left === 1 ? '' : 's'} still undecided — those lines are missing below`}
            </span>
          </header>
          <pre
            className={styles.code}
            ref={output}
            onScroll={() => follow(output.current, panes.current)}
          >
            {assembleSegments(blocks).map((segment) => {
              const key = `${String(segment.blockIndex)}:${segment.part}`;
              return editingAt === key ? (
                <textarea
                  key={key}
                  className={styles.editor}
                  aria-label="Edit these lines of the result"
                  value={draft}
                  rows={Math.max(draft.split('\n').length, 1)}
                  spellCheck={false}
                  ref={(element) => {
                    if (element !== null && document.activeElement !== element) {
                      element.focus();
                    }
                  }}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={() => commitEdit(segment.blockIndex, segment.part)}
                  onKeyDown={(event) => {
                    // Escape belongs to the box, not to the screen: it would
                    // otherwise throw away the whole resolution to cancel a
                    // typo.
                    if (event.key === 'Escape') {
                      event.stopPropagation();
                      setEditingAt(null);
                      return;
                    }
                    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault();
                      commitEdit(segment.blockIndex, segment.part);
                    }
                  }}
                />
              ) : (
                <span
                  key={key}
                  className={`${SEGMENT_CLASS[segment.origin] ?? ''}${
                    segment.edited === true ? ` ${styles.editedRun}` : ''
                  }`}
                  {...(segment.blockId === undefined
                    ? {}
                    : { 'data-block': segment.blockId })}
                  data-origin={segment.origin}
                  data-current={
                    segment.blockId !== undefined && segment.blockId === currentId
                      ? 'true'
                      : undefined
                  }
                  role="button"
                  tabIndex={0}
                  aria-label={`Edit ${String(segment.lines.length)} line${
                    segment.lines.length === 1 ? '' : 's'
                  } of the result`}
                  onDoubleClick={() => startEditing(segment)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === 'F2') {
                      event.preventDefault();
                      startEditing(segment);
                    }
                  }}
                >
                  {segment.lines.map((line, line_) => (
                    // Runs have no identity of their own; a line's position is
                    // what it is, and the list is rebuilt on every change.
                    // eslint-disable-next-line react/no-array-index-key
                    <span key={line_} className={styles.line}>
                      {line === '' ? ' ' : line}
                    </span>
                  ))}
                </span>
              );
            })}
          </pre>
        </section>
      </div>

      <footer className={styles.footer}>
        <button type="button" className={styles.action} onClick={onDone}>
          Cancel
        </button>
        <button
          type="button"
          className={styles.primary}
          disabled={busy || left > 0}
          title={
            left > 0
              ? 'Every block has to be decided before this file can be marked resolved.'
              : 'Write this result to the file and stage it'
          }
          onClick={save}
        >
          Save and mark resolved
        </button>
      </footer>
    </>
  );
}

/**
 * How each run of the output is drawn: agreed lines plain, decided ones tinted
 * by the side they came from. Colour is never the only cue — the runs also
 * carry `data-origin`, and the panes above say the same thing in words.
 */
const SEGMENT_CLASS: Record<'same' | 'ours' | 'theirs', string | undefined> = {
  same: styles.fromSame,
  ours: styles.fromOurs,
  theirs: styles.fromTheirs,
};

/**
 * One side's pane: agreed lines as context, conflicting ones as choices.
 *
 * The pane is `display: contents`, so its blocks are items of the *shared*
 * grid: each one is placed in its own column and on the row its index gives it,
 * which is the same row the other side's half of the same block lands on. Row 1
 * is the heading. The section itself stays in the markup — it is what names
 * this side for a screen reader, and the choice checkboxes are meaningless
 * without it.
 */
function Side({
  title,
  side,
  column,
  blocks,
  busy,
  currentId,
  onChoose,
}: {
  title: string;
  side: 'ours' | 'theirs';
  column: 1 | 2;
  blocks: Block[];
  busy: boolean;
  /** The block Previous/Next is standing on, marked on both sides. */
  currentId: number | null;
  onChoose: (id: number, choice: Choice) => void;
}): ReactNode {
  return (
    <section className={styles.pane} aria-label={title}>
      <h3
        className={styles.paneTitle}
        data-side={side}
        style={{ gridColumn: column, gridRow: 1 }}
      >
        {title}
      </h3>
      {blocks.map((block, index) =>
        block.kind === 'same' ? (
          <pre
            key={`same-${String(index)}`}
            className={styles.context}
            style={{ gridColumn: column, gridRow: index + 2 }}
          >
            {block.lines.join('\n')}
          </pre>
        ) : (
          <BlockChoice
            key={`block-${String(block.id)}`}
            block={block}
            side={side}
            busy={busy}
            current={block.id === currentId}
            style={{ gridColumn: column, gridRow: index + 2 }}
            onChoose={onChoose}
          />
        ),
      )}
    </section>
  );
}

function BlockChoice({
  block,
  side,
  busy,
  current,
  style,
  onChoose,
}: {
  block: Extract<Block, { kind: 'conflict' }>;
  side: 'ours' | 'theirs';
  busy: boolean;
  current: boolean;
  style: React.CSSProperties;
  onChoose: (id: number, choice: Choice) => void;
}): ReactNode {
  const lines = side === 'ours' ? block.ours : block.theirs;
  const taken = block.choice === side || block.choice === 'both';

  /**
   * Ticking one side keeps it; ticking both keeps both, in ours-then-theirs
   * order; unticking the last one means the block is dropped entirely, which is
   * a real answer for "we both added something and neither is wanted".
   */
  const toggle = (): void => {
    const other = side === 'ours' ? 'theirs' : 'ours';
    const otherTaken = block.choice === other || block.choice === 'both';
    if (taken) {
      onChoose(block.id, otherTaken ? other : 'neither');
      return;
    }
    onChoose(block.id, otherTaken ? 'both' : side);
  };

  return (
    <div
      className={`${taken ? `${styles.block} ${styles.blockTaken}` : styles.block}${
        current ? ` ${styles.blockCurrent}` : ''
      }`}
      style={style}
      data-block={block.id}
      data-side={side}
      data-taken={taken ? 'true' : undefined}
      data-current={current ? 'true' : undefined}
    >
      <label className={styles.blockPick}>
        <input
          type="checkbox"
          checked={taken}
          disabled={busy}
          aria-label={`Take block ${String(block.id + 1)} from this side`}
          onChange={toggle}
        />
        <span className={styles.blockLabel}>
          {lines.length === 0
            ? 'nothing on this side'
            : `${String(lines.length)} line${lines.length === 1 ? '' : 's'}`}
        </span>
        {/*
          Said in words, not only in the tint: this box was ticked by the merge
          because the other side never touched these lines, and a user who
          disagrees needs to know that is why it is ticked.
        */}
        {block.auto === true && (
          <span
            className={styles.blockTag}
            title="Only one side changed these lines, so the merge took that side"
          >
            auto
          </span>
        )}
        {block.edited === true && (
          <span className={styles.blockTag} title="You edited these lines in the result">
            edited
          </span>
        )}
      </label>
      {lines.length > 0 && <pre className={styles.blockCode}>{lines.join('\n')}</pre>}
    </div>
  );
}
