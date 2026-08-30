/**
 * The conflict resolution screen: both sides, the choices, and the result.
 *
 * Three things about it are deliberate.
 *
 * **The result is not a preview.** The Output pane is produced by the same
 * `assemble` the Save button writes, so what the user reads is what lands on
 * disk. A pane that approximated the outcome would be worse than none.
 *
 * **Nothing is chosen until somebody chooses it.** An undecided block
 * contributes no lines, so a half-finished resolution visibly has a hole in it
 * and Save stays disabled. Defaulting to one side would look finished and be a
 * decision nobody made.
 *
 * **The sides come from the index, not from the file on disk.** The marked-up
 * working copy is ambiguous — a file may legitimately contain a line of seven
 * angle brackets — while stages 2 and 3 are exactly what each side had.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { readConflictSides, type ConflictSides } from '../../git/conflict';
import { resolveConflict } from '../../state/actions';
import { useAppState, useStore } from '../../state/hooks';
import { isBusy } from '../../state/store';
import { trapTab } from '../shell/trapTab';
import {
  assemble,
  assembleLines,
  buildBlocks,
  choose,
  chooseAll,
  conflictCount,
  endsWithNewline,
  toLines,
  tooLargeToCompare,
  undecided,
  type Block,
  type Choice,
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
        if (tooLargeToCompare(sides.ours.text, sides.theirs.text)) {
          setLoaded({ state: 'too-large' });
          return;
        }
        setLoaded({
          state: 'ready',
          sides,
          blocks: buildBlocks(toLines(sides.ours.text), toLines(sides.theirs.text)),
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
          {loaded.state === 'ready' && (
            <span className={styles.count}>
              {undecided(loaded.blocks).length} of {conflictCount(loaded.blocks)} left
            </span>
          )}
          <button type="button" className={styles.close} onClick={close}>
            Close
          </button>
        </header>

        {loaded.state === 'loading' && (
          <p className={styles.notice}>Reading both sides of the conflict…</p>
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
          className={styles.action}
          disabled={busy || total === 0}
          onClick={() => onBlocks(chooseAll(blocks, 'ours'))}
        >
          Take all from {labels.ours}
        </button>
        <button
          type="button"
          className={styles.action}
          disabled={busy || total === 0}
          onClick={() => onBlocks(chooseAll(blocks, 'theirs'))}
        >
          Take all from {labels.theirs}
        </button>
      </div>

      <div className={styles.panes}>
        <Side
          title={labels.ours}
          side="ours"
          blocks={blocks}
          busy={busy}
          onChoose={(id, choice) => onBlocks(choose(blocks, id, choice))}
        />
        <Side
          title={labels.theirs}
          side="theirs"
          blocks={blocks}
          busy={busy}
          onChoose={(id, choice) => onBlocks(choose(blocks, id, choice))}
        />
      </div>

      <section className={styles.output} aria-label="Output">
        <header className={styles.outputHeader}>
          <h3 className={styles.outputTitle}>Output</h3>
          <span className={styles.count}>
            {left === 0
              ? 'every block decided'
              : `${String(left)} block${left === 1 ? '' : 's'} still undecided — those lines are missing below`}
          </span>
        </header>
        <pre className={styles.code}>
          {assembleLines(blocks).map((line, index) => (
            // Lines have no identity of their own; their position is what they
            // are, and the list is rebuilt whenever a choice changes.
            // eslint-disable-next-line react/no-array-index-key
            <span key={index} className={styles.line}>
              {line === '' ? ' ' : line}
            </span>
          ))}
        </pre>
      </section>

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

/** One side's pane: agreed lines as context, conflicting ones as choices. */
function Side({
  title,
  side,
  blocks,
  busy,
  onChoose,
}: {
  title: string;
  side: 'ours' | 'theirs';
  blocks: Block[];
  busy: boolean;
  onChoose: (id: number, choice: Choice) => void;
}): ReactNode {
  return (
    <section className={styles.pane} aria-label={title}>
      <h3 className={styles.paneTitle}>{title}</h3>
      <div className={styles.paneBody}>
        {blocks.map((block, index) =>
          block.kind === 'same' ? (
            <pre key={`same-${String(index)}`} className={styles.context}>
              {block.lines.join('\n')}
            </pre>
          ) : (
            <BlockChoice
              key={`block-${String(block.id)}`}
              block={block}
              side={side}
              busy={busy}
              onChoose={onChoose}
            />
          ),
        )}
      </div>
    </section>
  );
}

function BlockChoice({
  block,
  side,
  busy,
  onChoose,
}: {
  block: Extract<Block, { kind: 'conflict' }>;
  side: 'ours' | 'theirs';
  busy: boolean;
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
      className={taken ? `${styles.block} ${styles.blockTaken}` : styles.block}
      data-block={block.id}
      data-taken={taken ? 'true' : undefined}
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
      </label>
      {lines.length > 0 && <pre className={styles.blockCode}>{lines.join('\n')}</pre>}
    </div>
  );
}
