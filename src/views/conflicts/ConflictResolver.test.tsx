import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readConflictSides } from '../../git/conflict';
import type { Operation } from '../../git/operation';
import { resolveConflict } from '../../state/actions';
import { StoreProvider } from '../../state/hooks';
import { createStore, type Store } from '../../state/store';
import { ConflictResolver, sideLabels } from './ConflictResolver';

vi.mock('../../git/conflict', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../git/conflict')>();
  return { ...actual, readConflictSides: vi.fn() };
});
vi.mock('../../state/actions', () => ({ resolveConflict: vi.fn() }));

const readSides = vi.mocked(readConflictSides);
const resolveMock = vi.mocked(resolveConflict);

const OURS = 'one\nmine\nthree\n';
const THEIRS = 'one\nyours\nthree\n';

function sides(ours = OURS, theirs = THEIRS) {
  return {
    base: { text: 'one\nbase\nthree\n', present: true },
    ours: { text: ours, present: true },
    theirs: { text: theirs, present: true },
  };
}

function renderResolver(options: { operation?: Operation['kind'] } = {}): Store {
  const store = createStore();
  store.dispatch({
    type: 'repo/opened',
    repo: { root: 'C:/repo', gitDir: 'C:/repo/.git', bare: false, empty: false },
  });
  if (options.operation !== undefined) {
    store.dispatch({
      type: 'operation/read',
      operation: {
        kind: options.operation,
        commit: null,
        step: null,
        steps: null,
        branch: null,
      },
    });
  }
  store.dispatch({ type: 'resolve/open', path: 'src/app.ts' });
  render(
    <StoreProvider store={store}>
      <ConflictResolver />
    </StoreProvider>,
  );
  return store;
}

/** The Output pane's text, which is what will be written. */
function output(): string {
  return screen.getByLabelText('Output').textContent ?? '';
}

/** The checkbox for block `n` on one side. */
function block(side: string, n: number): HTMLElement {
  return within(screen.getByRole('region', { name: side })).getAllByRole('checkbox')[
    n
  ] as HTMLElement;
}

beforeEach(() => {
  readSides.mockReset().mockResolvedValue(sides());
  resolveMock.mockReset().mockResolvedValue(true);
});

afterEach(cleanup);

describe('sideLabels', () => {
  it('swaps the names round for a rebase, because git does', () => {
    // During a rebase your commits are replayed onto the other branch, so
    // stage 2 is the upstream and stage 3 is yours. A screen that says "yours"
    // over the wrong pane gets somebody's work thrown away.
    expect(sideLabels('rebase')).toEqual({
      ours: 'Upstream (rebased onto)',
      theirs: 'Your commit (being replayed)',
    });
    expect(sideLabels('merge').ours).toContain('current branch');
  });
});

describe('the screen', () => {
  it('shows nothing until a file is opened', () => {
    const store = createStore();
    render(
      <StoreProvider store={store}>
        <ConflictResolver />
      </StoreProvider>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reads both sides out of the index and names the file', async () => {
    renderResolver();
    await screen.findByRole('dialog', { name: 'Resolve src/app.ts' });
    expect(readSides).toHaveBeenCalledWith('C:/repo', 'src/app.ts');
  });

  it('closes without writing anything', async () => {
    const store = renderResolver();
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(store.getState().resolving).toBeNull();
    expect(resolveMock).not.toHaveBeenCalled();
  });
});

describe('choosing blocks', () => {
  it('starts with the disputed lines missing from the output', async () => {
    renderResolver();
    await screen.findByRole('dialog');

    // The agreed lines are there; the undecided block contributes nothing, so
    // a half-answered resolution visibly has a hole in it.
    expect(output()).toContain('one');
    expect(output()).toContain('three');
    expect(output()).not.toContain('mine');
    expect(output()).not.toContain('yours');
  });

  it('will not save while a block is undecided', async () => {
    renderResolver();
    await screen.findByRole('dialog');
    expect(screen.getByRole('button', { name: 'Save and mark resolved' })).toBeDisabled();
  });

  it('puts the chosen side into the output', async () => {
    renderResolver();
    await screen.findByRole('dialog');

    fireEvent.click(block('Theirs (incoming)', 0));

    expect(output()).toContain('yours');
    expect(output()).not.toContain('mine');
  });

  it('keeps both sides, ours first, when both are ticked', async () => {
    renderResolver();
    await screen.findByRole('dialog');

    fireEvent.click(block('Ours (current branch)', 0));
    fireEvent.click(block('Theirs (incoming)', 0));

    const text = output();
    expect(text.indexOf('mine')).toBeGreaterThan(-1);
    expect(text.indexOf('mine')).toBeLessThan(text.indexOf('yours'));
  });

  it('drops the block when a ticked side is unticked again', async () => {
    renderResolver();
    await screen.findByRole('dialog');

    fireEvent.click(block('Ours (current branch)', 0));
    expect(output()).toContain('mine');

    fireEvent.click(block('Ours (current branch)', 0));
    // "Neither side" is a real answer, and it is a decided one.
    expect(output()).not.toContain('mine');
    expect(screen.getByRole('button', { name: 'Save and mark resolved' })).toBeEnabled();
  });

  it('takes every block from one side at once', async () => {
    renderResolver();
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: /Take all from Ours/ }));

    expect(output()).toContain('mine');
    expect(screen.getByRole('button', { name: 'Save and mark resolved' })).toBeEnabled();
  });
});

describe('saving', () => {
  it('writes exactly what the Output pane shows, then closes', async () => {
    const store = renderResolver();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /Take all from Theirs/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Save and mark resolved' }));

    await waitFor(() => expect(resolveMock).toHaveBeenCalledTimes(1));
    // The preview is not an approximation of the result; it is produced by the
    // same function that writes.
    expect(resolveMock).toHaveBeenCalledWith(store, 'src/app.ts', THEIRS);
    await waitFor(() => expect(store.getState().resolving).toBeNull());
  });

  it('stays open when the write was refused', async () => {
    resolveMock.mockResolvedValue(false);
    const store = renderResolver();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /Take all from Ours/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Save and mark resolved' }));

    await waitFor(() => expect(resolveMock).toHaveBeenCalled());
    expect(store.getState().resolving).toBe('src/app.ts');
  });
});

describe('when the file cannot be shown', () => {
  it('says so rather than showing an empty screen', async () => {
    readSides.mockRejectedValue(new Error('not in the index'));
    renderResolver();

    expect(await screen.findByRole('alert')).toHaveTextContent('not in the index');
  });

  it('refuses a file too large to compare, and says where to go instead', async () => {
    const huge = `${'x\n'.repeat(5000)}`;
    readSides.mockResolvedValue(sides(huge, huge));
    renderResolver();

    expect(await screen.findByRole('alert')).toHaveTextContent('too large to compare');
  });
});
