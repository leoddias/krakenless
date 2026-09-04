import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileDiff, Hunk } from '../../git/types';
import { discardHunk, stageHunks } from '../../state/actions';
import { StoreProvider } from '../../state/hooks';
import { createStore, type Store } from '../../state/store';
import { registerStore, resetStoreRegistry } from '../../state/stores';
import { DiffView } from './DiffView';

// Only the two hunk actions are replaced: the editor tests below drive the
// real `openFileForEdit`, and a blanket mock would take them out with it.
vi.mock('../../state/actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../state/actions')>()),
  discardHunk: vi.fn().mockResolvedValue(undefined),
  stageHunks: vi.fn().mockResolvedValue(undefined),
}));

const stageMock = vi.mocked(stageHunks);
const discardMock = vi.mocked(discardHunk);

beforeEach(() => {
  stageMock.mockClear();
  discardMock.mockClear();
});

// Vitest runs without `globals`, so Testing Library's auto-cleanup is not
// registered for us — without this each render leaks into the next test.
afterEach(cleanup);

function renderView(prepare: (store: Store) => void = () => {}) {
  const store = createStore();
  prepare(store);
  render(
    <StoreProvider store={store}>
      <DiffView />
    </StoreProvider>,
  );
  return store;
}

function fileDiff(overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    oldPath: 'src/a.ts',
    newPath: 'src/a.ts',
    kind: 'modified',
    binary: false,
    conflicted: false,
    side: 'unstaged',
    headerLines: ['diff --git a/src/a.ts b/src/a.ts'],
    hunks: [],
    ...overrides,
  };
}

const sampleHunk: Hunk = {
  header: '@@ -1,3 +1,3 @@ function main()',
  oldStart: 1,
  oldLines: 3,
  newStart: 1,
  newLines: 3,
  lines: [
    { kind: 'context', text: 'const a = 1;', oldLine: 1, newLine: 1 },
    { kind: 'deleted', text: 'const b = 2;', oldLine: 2 },
    { kind: 'added', text: 'const b = 3;', newLine: 2 },
    { kind: 'context', text: 'export {};', oldLine: 3, newLine: 3 },
  ],
};

function lineRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-kind]'));
}

function lineRow(index: number): HTMLElement {
  const row = lineRows()[index];
  if (row === undefined) throw new Error(`no diff line at index ${index}`);
  return row;
}

describe('DiffView panel states', () => {
  it('says nothing is selected while idle', () => {
    renderView();
    expect(screen.getByText('No diff to show')).toBeInTheDocument();
  });

  it('reports loading', () => {
    renderView((store) => store.dispatch({ type: 'diff/loading' }));
    expect(screen.getByText('Loading diff…')).toBeInTheDocument();
  });

  it('reports an empty diff as "no changes" rather than blank', () => {
    renderView((store) => store.dispatch({ type: 'diff/loaded', files: [] }));
    expect(screen.getByText('No changes')).toBeInTheDocument();
  });

  it('shows a generic error message with its detail', () => {
    renderView((store) =>
      store.dispatch({
        type: 'diff/failed',
        message: 'git exited with code 128',
        kind: 'command-failed',
      }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the diff');
    expect(screen.getByText('git exited with code 128')).toBeInTheDocument();
  });

  it('explains that undecodable output cannot be shown safely', () => {
    renderView((store) =>
      store.dispatch({
        type: 'diff/failed',
        message: 'stdout was not valid UTF-8',
        kind: 'undecodable-output',
      }),
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Diff cannot be shown safely');
    expect(alert).toHaveTextContent(/bytes are not valid UTF-8/);
    expect(alert).toHaveTextContent(/cannot be decoded without corrupting it/);
    expect(alert).toHaveTextContent('stdout was not valid UTF-8');
  });
});

describe('DiffView hunk rendering', () => {
  it('renders every line with the line numbers of the side it exists on', () => {
    renderView((store) =>
      store.dispatch({ type: 'diff/loaded', files: [fileDiff({ hunks: [sampleHunk] })] }),
    );

    expect(screen.getByText('@@ -1,3 +1,3 @@ function main()')).toBeInTheDocument();

    const rows = lineRows();
    expect(rows).toHaveLength(4);
    const shape = rows.map((row) => [
      row.dataset.kind,
      row.dataset.oldLine,
      row.dataset.newLine,
      row.textContent,
    ]);
    expect(shape).toEqual([
      ['context', '1', '1', 'context: 11 const a = 1;'],
      ['deleted', '2', '', 'deleted: 2-const b = 2;'],
      ['added', '', '2', 'added: 2+const b = 3;'],
      ['context', '3', '3', 'context: 33 export {};'],
    ]);
  });

  it('preserves line content verbatim, including leading whitespace and tabs', () => {
    const text = '\t  const indented = "  spaced  ";  ';
    renderView((store) =>
      store.dispatch({
        type: 'diff/loaded',
        files: [
          fileDiff({
            hunks: [
              {
                ...sampleHunk,
                lines: [{ kind: 'added', text, newLine: 7 }],
              },
            ],
          }),
        ],
      }),
    );
    const content = lineRow(0).querySelector('span:last-child');
    expect(content?.textContent).toBe(text);
  });

  it('renders the no-newline marker as its own line without line numbers', () => {
    renderView((store) =>
      store.dispatch({
        type: 'diff/loaded',
        files: [
          fileDiff({
            hunks: [
              {
                ...sampleHunk,
                lines: [
                  { kind: 'added', text: 'tail', newLine: 1 },
                  { kind: 'no-newline', text: 'No newline at end of file' },
                ],
              },
            ],
          }),
        ],
      }),
    );
    const marker = lineRow(1);
    expect(marker.dataset.kind).toBe('no-newline');
    expect(marker.dataset.oldLine).toBe('');
    expect(marker.dataset.newLine).toBe('');
    expect(marker).toHaveTextContent('No newline at end of file');
  });

  it('counts added and deleted lines per file, ignoring no-newline markers', () => {
    renderView((store) =>
      store.dispatch({
        type: 'diff/loaded',
        files: [
          fileDiff({
            hunks: [
              {
                ...sampleHunk,
                lines: [
                  ...sampleHunk.lines,
                  { kind: 'no-newline', text: 'No newline at end of file' },
                ],
              },
            ],
          }),
        ],
      }),
    );
    // Scoped to the file list: the per-hunk buttons name their file too.
    const list = screen.getByRole('navigation', { name: 'Changed files' });
    const button = within(list).getByRole('button', { name: /src\/a\.ts/ });
    expect(within(button).getByText('+1')).toBeInTheDocument();
    expect(within(button).getByText('-1')).toBeInTheDocument();
  });
});

describe('DiffView special file entries', () => {
  it('labels a binary file instead of rendering nothing', () => {
    renderView((store) =>
      store.dispatch({
        type: 'diff/loaded',
        files: [fileDiff({ newPath: 'logo.png', oldPath: 'logo.png', binary: true })],
      }),
    );
    expect(screen.getByText(/Binary file/)).toBeInTheDocument();
  });

  it('labels a conflicted file as conflicted, not as an empty change', () => {
    renderView((store) =>
      store.dispatch({
        type: 'diff/loaded',
        files: [fileDiff({ conflicted: true })],
      }),
    );
    expect(screen.getByText(/Conflicted file/)).toBeInTheDocument();
    expect(screen.queryByText('No changes')).not.toBeInTheDocument();
  });

  it('labels a mode-only change and shows the old and new mode', () => {
    renderView((store) =>
      store.dispatch({
        type: 'diff/loaded',
        files: [
          fileDiff({
            headerLines: [
              'diff --git a/run.sh b/run.sh',
              'old mode 100644',
              'new mode 100755',
            ],
            newPath: 'run.sh',
            oldPath: 'run.sh',
          }),
        ],
      }),
    );
    expect(screen.getByText(/File mode changed only/)).toBeInTheDocument();
    expect(screen.getByText(/100644 → 100755/)).toBeInTheDocument();
  });

  it('shows a rename as oldPath → newPath and says the contents are unchanged', () => {
    renderView((store) =>
      store.dispatch({
        type: 'diff/loaded',
        files: [
          fileDiff({ kind: 'renamed', oldPath: 'src/old.ts', newPath: 'src/new.ts' }),
        ],
      }),
    );
    expect(screen.getAllByText('src/old.ts → src/new.ts').length).toBeGreaterThan(0);
    expect(screen.getByText(/Renamed only/)).toBeInTheDocument();
  });

  it('shows a copy as oldPath → newPath', () => {
    renderView((store) =>
      store.dispatch({
        type: 'diff/loaded',
        files: [fileDiff({ kind: 'copied', oldPath: 'src/a.ts', newPath: 'src/b.ts' })],
      }),
    );
    expect(screen.getAllByText('src/a.ts → src/b.ts').length).toBeGreaterThan(0);
    expect(screen.getByText(/Copied only/)).toBeInTheDocument();
  });

  it('labels an empty new file', () => {
    renderView((store) =>
      store.dispatch({
        type: 'diff/loaded',
        files: [fileDiff({ kind: 'added', oldPath: 'empty.txt', newPath: 'empty.txt' })],
      }),
    );
    expect(screen.getByText(/New empty file/)).toBeInTheDocument();
  });
});

describe('DiffView file selection', () => {
  const files = [
    fileDiff({ oldPath: 'src/a.ts', newPath: 'src/a.ts', hunks: [sampleHunk] }),
    fileDiff({ oldPath: 'src/b.ts', newPath: 'src/b.ts', kind: 'added', binary: true }),
  ];

  it('shows the first file, and only that one, while no path is selected', () => {
    // Every commit click lands in this state. Mounting all of them here is what
    // made walking a history of large commits lock the window up.
    renderView((store) => store.dispatch({ type: 'diff/loaded', files }));
    expect(screen.getByRole('article', { name: 'src/a.ts' })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'src/b.ts' })).not.toBeInTheDocument();
  });

  it('marks the file it fell back to, so the list is not lying', () => {
    renderView((store) => store.dispatch({ type: 'diff/loaded', files }));
    const list = within(screen.getByRole('navigation', { name: 'Changed files' }));
    expect(list.getByRole('button', { name: /src\/a\.ts/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('falls back per diff instead of carrying the last file over', () => {
    const store = renderView((s) => s.dispatch({ type: 'diff/loaded', files }));
    fireEvent.click(screen.getByRole('button', { name: /src\/b\.ts/ }));
    expect(screen.getByRole('article', { name: 'src/b.ts' })).toBeInTheDocument();

    // Another commit: the selection is cleared with it, so the new diff opens
    // on its own first file rather than on "src/b.ts is not in this diff".
    act(() => {
      store.dispatch({ type: 'selection/commit', oid: 'f'.repeat(40) });
      store.dispatch({
        type: 'diff/loaded',
        files: [
          fileDiff({ oldPath: 'src/c.ts', newPath: 'src/c.ts', hunks: [sampleHunk] }),
        ],
      });
    });
    expect(screen.getByRole('article', { name: 'src/c.ts' })).toBeInTheDocument();
  });

  it('lists how many files changed, without offering to render them all', () => {
    renderView((store) => store.dispatch({ type: 'diff/loaded', files }));
    expect(screen.getByText('2 changed files')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /All files/ })).toBeNull();
  });

  it('selects a file through the store and narrows the body to it', () => {
    const store = renderView((s) => s.dispatch({ type: 'diff/loaded', files }));

    fireEvent.click(screen.getByRole('button', { name: /src\/b\.ts/ }));

    expect(store.getState().selection.path).toBe('src/b.ts');
    expect(screen.getByRole('article', { name: 'src/b.ts' })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'src/a.ts' })).not.toBeInTheDocument();
  });

  it('moves the body when another file is picked', () => {
    const store = renderView((s) => {
      s.dispatch({ type: 'diff/loaded', files });
      s.dispatch({ type: 'selection/path', path: 'src/b.ts' });
    });

    fireEvent.click(screen.getByRole('button', { name: /src\/a\.ts/ }));

    expect(store.getState().selection.path).toBe('src/a.ts');
    expect(screen.getByRole('article', { name: 'src/a.ts' })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'src/b.ts' })).not.toBeInTheDocument();
  });

  it('says so when the selected path is not part of the diff', () => {
    renderView((store) => {
      store.dispatch({ type: 'diff/loaded', files });
      store.dispatch({ type: 'selection/path', path: 'src/gone.ts' });
    });
    expect(screen.getByText('File not in this diff')).toBeInTheDocument();
    expect(
      screen.getByText(/"src\/gone\.ts" is not part of the current selection/),
    ).toBeInTheDocument();
  });
});

describe('DiffView editing', () => {
  function withDiff(files: FileDiff[], commitOid: string | null = null) {
    return renderView((store) => {
      store.dispatch({ type: 'selection/commit', oid: commitOid });
      store.dispatch({ type: 'diff/loaded', files });
    });
  }

  it('offers to edit a file in the working tree', () => {
    withDiff([fileDiff({ hunks: [sampleHunk] })]);
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('does not offer to edit a commit, which has nothing on disk to write', () => {
    withDiff([fileDiff({ hunks: [sampleHunk] })], 'abc1234');
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('does not offer to edit a file that was deleted', () => {
    withDiff([fileDiff({ kind: 'deleted', hunks: [sampleHunk] })]);
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('edits a renamed file at the path it now has', () => {
    withDiff([
      fileDiff({
        kind: 'renamed',
        oldPath: 'src/old.ts',
        newPath: 'src/new.ts',
        hunks: [sampleHunk],
      }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    // The editor names the file it opened; a rename must not send it looking
    // for the path that no longer exists.
    expect(screen.getByText(/Opening src\/new\.ts/)).toBeInTheDocument();
  });

  it('replaces the diff with the editor, and puts it back on close', async () => {
    withDiff([fileDiff({ hunks: [sampleHunk] })]);
    expect(lineRows().length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(lineRows()).toHaveLength(0);

    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(lineRows().length).toBeGreaterThan(0);
  });
});

describe('per-hunk actions', () => {
  function showFile(overrides: Partial<FileDiff> = {}): Store {
    return renderView((store) =>
      store.dispatch({
        type: 'diff/loaded',
        files: [fileDiff({ hunks: [sampleHunk], ...overrides })],
      }),
    );
  }

  it('stages the one hunk that was clicked, not the file', () => {
    const store = showFile();

    fireEvent.click(screen.getByRole('button', { name: /^Stage Hunk of src\/a\.ts/ }));

    expect(stageMock).toHaveBeenCalledWith(store, expect.anything(), [sampleHunk], {
      reverse: false,
    });
  });

  it('unstages from the staged side, in the other direction', () => {
    // Same button position, opposite effect. The side is the only thing that
    // says which, and both entries for one path can be on screen at once.
    const store = showFile({ side: 'staged' });

    fireEvent.click(screen.getByRole('button', { name: /^Unstage Hunk of src\/a\.ts/ }));

    expect(stageMock).toHaveBeenCalledWith(store, expect.anything(), [sampleHunk], {
      reverse: true,
    });
    expect(screen.queryByRole('button', { name: /Discard Hunk/ })).toBeNull();
  });

  it('offers nothing on a commit, which has nothing to move', () => {
    showFile({ side: 'commit' });
    expect(screen.queryByRole('button', { name: /Hunk/ })).toBeNull();
  });

  it('asks before discarding, and does nothing until the answer', () => {
    showFile();

    fireEvent.click(screen.getByRole('button', { name: /^Discard Hunk of src\/a\.ts/ }));

    expect(discardMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm discard hunk' });
    expect(dialog).toHaveTextContent('src/a.ts');
  });

  it('discards only after the confirmation is answered', () => {
    const store = showFile();
    fireEvent.click(screen.getByRole('button', { name: /^Discard Hunk of src\/a\.ts/ }));

    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard hunk' }));

    expect(discardMock).toHaveBeenCalledTimes(1);
    // The reason travels with the call: the confirmation token is minted from
    // the words the user actually saw.
    expect(discardMock).toHaveBeenCalledWith(
      store,
      expect.anything(),
      [sampleHunk],
      expect.stringContaining('src/a.ts'),
    );
  });

  it('cancelling discards nothing and closes the question', () => {
    showFile();
    fireEvent.click(screen.getByRole('button', { name: /^Discard Hunk of src\/a\.ts/ }));

    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }),
    );

    expect(discardMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('offers no hunk buttons for a file no patch can be built for', () => {
    // `serializeHunks` throws on these, so a button could only ever fail.
    showFile({ kind: 'renamed', oldPath: 'src/old.ts' });

    expect(screen.queryByRole('button', { name: /Stage Hunk/ })).toBeNull();
    expect(screen.getByText(/Hunk-level staging is not available/)).toBeInTheDocument();
  });

  it('tells the two sides of one path apart in the file list', () => {
    renderView((store) =>
      store.dispatch({
        type: 'diff/loaded',
        files: [
          fileDiff({ hunks: [sampleHunk] }),
          fileDiff({ hunks: [sampleHunk], side: 'staged' }),
        ],
      }),
    );

    const list = screen.getByRole('navigation', { name: 'Changed files' });
    expect(within(list).getByText('Unstaged')).toBeInTheDocument();
    expect(within(list).getByText('Staged')).toBeInTheDocument();
  });

  it('disables the buttons while a git command is running', () => {
    // A second click queued behind an in-flight apply would build its patch
    // from a diff the first one has already invalidated.
    const store = showFile();
    act(() => {
      store.dispatch({ type: 'busy', busy: true });
    });

    for (const button of screen.getAllByRole('button', { name: /Hunk of src/ })) {
      expect(button).toBeDisabled();
    }
  });
});

describe('DiffView — large diffs stay responsive', () => {
  function bigHunk(count: number): Hunk {
    return {
      header: `@@ -1,${count} +1,${count} @@`,
      oldStart: 1,
      oldLines: count,
      newStart: 1,
      newLines: count,
      lines: Array.from({ length: count }, (_, i) => ({
        kind: 'context' as const,
        text: `line ${i}`,
        oldLine: i + 1,
        newLine: i + 1,
      })),
    };
  }

  it('collapses a large file behind an explicit control instead of freezing', () => {
    renderView((store) =>
      store.dispatch({
        type: 'diff/loaded',
        files: [fileDiff({ newPath: 'big.lock', side: 'commit', hunks: [bigHunk(500)] })],
      }),
    );

    // Not one of its 500 lines is in the DOM, and the control says how many
    // it is holding back.
    expect(lineRows().length).toBe(0);
    expect(screen.getByText(/This diff is large [(]500 lines[)]/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Show 500 lines/ }));
    expect(lineRows().length).toBe(500);
  });

  it('reveals an enormous file in bounded chunks, never all at once', () => {
    renderView((store) =>
      store.dispatch({
        type: 'diff/loaded',
        files: [
          fileDiff({ newPath: 'huge.lock', side: 'commit', hunks: [bigHunk(2_500)] }),
        ],
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Show 1,000 lines/ }));
    expect(lineRows().length).toBe(1_000);
    expect(screen.getByText(/1,500 more lines/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Show 1,000 more lines/ }));
    expect(lineRows().length).toBe(2_000);
  });

  it('leaves a small file fully rendered even after a huge one', () => {
    renderView((store) =>
      store.dispatch({
        type: 'diff/loaded',
        files: [
          fileDiff({ newPath: 'big.lock', side: 'commit', hunks: [bigHunk(2_000)] }),
          fileDiff({ newPath: 'src/a.ts', side: 'commit', hunks: [sampleHunk] }),
        ],
      }),
    );
    // Its neighbour being enormous is not its problem: each file is planned on
    // its own size, and only the file on screen is built.
    fireEvent.click(screen.getByRole('button', { name: /src\/a\.ts/ }));
    expect(lineRows().length).toBe(sampleHunk.lines.length);
  });

  it('starts a new diff from a clean slate, not the previous reveals', () => {
    const store = renderView((s) =>
      s.dispatch({
        type: 'diff/loaded',
        files: [fileDiff({ newPath: 'big.lock', side: 'commit', hunks: [bigHunk(600)] })],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Show 600 lines/ }));
    expect(lineRows().length).toBe(600);

    // A different commit's diff arrives with a file of the same path: the old
    // reveal must not leak onto it.
    act(() => {
      store.dispatch({
        type: 'diff/loaded',
        files: [fileDiff({ newPath: 'big.lock', side: 'commit', hunks: [bigHunk(700)] })],
      });
    });
    expect(lineRows().length).toBe(0);
    expect(screen.getByRole('button', { name: /Show 700 lines/ })).toBeInTheDocument();
  });

  it('shows the file counts without rendering the lines', () => {
    renderView((store) =>
      store.dispatch({
        type: 'diff/loaded',
        files: [
          fileDiff({
            newPath: 'big.lock',
            side: 'commit',
            hunks: [
              {
                ...bigHunk(450),
                lines: bigHunk(450).lines.map((line, i) =>
                  i < 40 ? { kind: 'added' as const, text: 'x', newLine: i + 1 } : line,
                ),
              },
            ],
          }),
        ],
      }),
    );
    expect(screen.getByText('+40')).toBeInTheDocument();
    expect(lineRows().length).toBe(0);
  });
});

describe('DiffView — collapse reasons stay honest', () => {
  it('renders a small file whatever the diff around it looks like', () => {
    const hunk100: Hunk = {
      header: '@@ -1,100 +1,100 @@',
      oldStart: 1,
      oldLines: 100,
      newStart: 1,
      newLines: 100,
      lines: Array.from({ length: 100 }, (_, i) => ({
        kind: 'context' as const,
        text: `line ${i}`,
        oldLine: i + 1,
        newLine: i + 1,
      })),
    };
    renderView((store) =>
      store.dispatch({
        type: 'diff/loaded',
        files: Array.from({ length: 21 }, (_, i) =>
          fileDiff({ newPath: `f${i}.ts`, side: 'commit', hunks: [hunk100] }),
        ),
      }),
    );

    // A 100-line file is a 100-line file, whether it is the first of twenty-one
    // or the only one. Nothing is held back, and nothing calls it large.
    expect(lineRows().length).toBe(100);
    expect(screen.queryByText(/This diff is large/)).toBeNull();
    expect(screen.queryByText(/not rendered yet/)).toBeNull();
  });
});

describe('DiffView — a truncated hunk withholds its actions', () => {
  const bigWorktreeHunk: Hunk = {
    header: '@@ -1,1500 +1,1500 @@',
    oldStart: 1,
    oldLines: 1500,
    newStart: 1,
    newLines: 1500,
    lines: Array.from({ length: 1500 }, (_, i) => ({
      kind: 'added' as const,
      text: `line ${i}`,
      newLine: i + 1,
    })),
  };

  it('offers no stage or discard button while part of the hunk is unseen', () => {
    renderView((store) =>
      store.dispatch({
        type: 'diff/loaded',
        files: [
          fileDiff({ newPath: 'big.txt', side: 'unstaged', hunks: [bigWorktreeHunk] }),
        ],
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Show 1,000 lines/ }));
    expect(lineRows().length).toBe(1_000);
    // The buttons act on the whole hunk; 500 of its lines are not on screen.
    expect(screen.queryByRole('button', { name: /Stage Hunk/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Discard Hunk/ })).toBeNull();
    expect(screen.getByText(/Show the rest to stage or discard it/)).toBeInTheDocument();

    // Revealing the rest brings the actions back.
    fireEvent.click(screen.getByRole('button', { name: /Show 500 more lines/ }));
    expect(lineRows().length).toBe(1_500);
    expect(screen.getByRole('button', { name: /Stage Hunk/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Discard Hunk/ })).toBeInTheDocument();
  });
});

describe('the file list: its width, and its shape', () => {
  const files = [
    fileDiff({
      oldPath: 'src/views/a.ts',
      newPath: 'src/views/a.ts',
      hunks: [sampleHunk],
    }),
    fileDiff({
      oldPath: 'src/views/b.ts',
      newPath: 'src/views/b.ts',
      hunks: [sampleHunk],
    }),
    fileDiff({ oldPath: 'README.md', newPath: 'README.md', hunks: [sampleHunk] }),
  ];

  afterEach(() => {
    resetStoreRegistry();
  });

  it('has a draggable edge, so a deep path is never stuck behind an ellipsis', () => {
    renderView((store) => store.dispatch({ type: 'diff/loaded', files }));

    const edge = screen.getByRole('separator', { name: 'Resize the file list' });
    expect(edge).toHaveAttribute('aria-valuenow', '272');
  });

  it('carries the full path on every row, for the tooltip a narrow list needs', () => {
    renderView((store) => store.dispatch({ type: 'diff/loaded', files }));

    // Scoped to the list: the hunk buttons in the body name the file too.
    const list = screen.getByRole('navigation', { name: 'Changed files' });
    expect(
      within(list).getByRole('button', { name: /src\/views\/a\.ts/ }),
    ).toHaveAttribute('title', 'src/views/a.ts');
  });

  it('lists full paths by default and offers the tree', () => {
    renderView((store) => store.dispatch({ type: 'diff/loaded', files }));

    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Tree' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.queryByRole('tree')).toBeNull();
  });

  it('groups the files by directory in tree mode, and remembers the choice', () => {
    const store = renderView((s) => {
      registerStore(s);
      s.dispatch({ type: 'diff/loaded', files });
    });

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Tree' }));
    });

    // One row for the collapsed `src/views`, the file names on their own.
    const tree = screen.getByRole('tree');
    expect(within(tree).getByRole('button', { name: 'src/views' })).toBeInTheDocument();
    expect(within(tree).getByRole('button', { name: /^a\.ts/ })).toBeInTheDocument();
    expect(within(tree).getByRole('button', { name: /^README\.md/ })).toBeInTheDocument();
    expect(store.getState().config.diffFileList).toBe('tree');
  });

  it('still selects a file from the tree', () => {
    const store = renderView((s) => {
      s.dispatch({
        type: 'config/loaded',
        config: { ...s.getState().config, diffFileList: 'tree' },
      });
      s.dispatch({ type: 'diff/loaded', files });
    });

    fireEvent.click(screen.getByRole('button', { name: /^b\.ts/ }));

    expect(store.getState().selection.path).toBe('src/views/b.ts');
    expect(screen.getByRole('article', { name: 'src/views/b.ts' })).toBeInTheDocument();
  });

  it('folds a directory out of the way and opens it again', () => {
    renderView((s) => {
      s.dispatch({
        type: 'config/loaded',
        config: { ...s.getState().config, diffFileList: 'tree' },
      });
      s.dispatch({ type: 'diff/loaded', files });
    });
    const folder = screen.getByRole('button', { name: 'src/views' });

    fireEvent.click(folder);
    expect(folder).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: /^a\.ts/ })).toBeNull();
    // The rest of the tree is untouched.
    expect(screen.getByRole('button', { name: /^README\.md/ })).toBeInTheDocument();

    fireEvent.click(folder);
    expect(screen.getByRole('button', { name: /^a\.ts/ })).toBeInTheDocument();
  });
});
