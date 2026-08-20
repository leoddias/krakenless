import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FileDiff, Hunk } from '../../git/types';
import { StoreProvider } from '../../state/hooks';
import { createStore, type Store } from '../../state/store';
import { DiffView } from './DiffView';

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
    const button = screen.getByRole('button', { name: /src\/a\.ts/ });
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

  it('shows every file while no path is selected', () => {
    renderView((store) => store.dispatch({ type: 'diff/loaded', files }));
    expect(screen.getByRole('article', { name: 'src/a.ts' })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'src/b.ts' })).toBeInTheDocument();
  });

  it('selects a file through the store and narrows the body to it', () => {
    const store = renderView((s) => s.dispatch({ type: 'diff/loaded', files }));

    fireEvent.click(screen.getByRole('button', { name: /src\/b\.ts/ }));

    expect(store.getState().selection.path).toBe('src/b.ts');
    expect(screen.getByRole('article', { name: 'src/b.ts' })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'src/a.ts' })).not.toBeInTheDocument();
  });

  it('goes back to all files and marks the active entry', () => {
    const store = renderView((s) => {
      s.dispatch({ type: 'diff/loaded', files });
      s.dispatch({ type: 'selection/path', path: 'src/b.ts' });
    });

    fireEvent.click(screen.getByRole('button', { name: /All files/ }));

    expect(store.getState().selection.path).toBeNull();
    expect(screen.getByRole('button', { name: /All files/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('article', { name: 'src/a.ts' })).toBeInTheDocument();
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
