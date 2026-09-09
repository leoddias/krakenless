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

const BASE = 'one\nbase\nthree\n';
const OURS = 'one\nmine\nthree\n';
const THEIRS = 'one\nyours\nthree\n';

/** Three separate disagreements, for the navigation and the bulk choices. */
const THREE_BASE = 'a\nbase1\nb\nbase2\nc\nbase3\nd\n';
const THREE_OURS = 'a\nmine1\nb\nmine2\nc\nmine3\nd\n';
const THREE_THEIRS = 'a\nyours1\nb\nyours2\nc\nyours3\nd\n';

/**
 * The three index stages.
 *
 * The base is a real one, not a placeholder: the screen judges each side
 * against it, and a base that resembles neither side turns the whole file into
 * one conflict — which is what the merge is supposed to tell us, so the
 * fixtures have to mean it.
 */
function sides(ours = OURS, theirs = THEIRS, base = BASE) {
  return {
    base: { text: base, present: true },
    ours: { text: ours, present: true },
    theirs: { text: theirs, present: true },
  };
}

/** An add/add conflict: neither side inherited the file, so there is no base. */
function addAdd(ours: string, theirs: string) {
  return {
    base: { text: '', present: false },
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

  it('takes both sides of every block at once', async () => {
    readSides.mockResolvedValue(sides(THREE_OURS, THREE_THEIRS, THREE_BASE));
    renderResolver();
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: 'Take both, everywhere' }));

    // Every disputed line survives, ours before theirs — the answer when two
    // branches added different things and the file wants all of them.
    const text = output();
    for (const line of ['mine1', 'yours1', 'mine2', 'yours2', 'mine3', 'yours3']) {
      expect(text).toContain(line);
    }
    expect(text.indexOf('mine1')).toBeLessThan(text.indexOf('yours1'));
    expect(screen.getByRole('button', { name: 'Save and mark resolved' })).toBeEnabled();
  });
});

describe('walking the conflicts', () => {
  /** Ids of the blocks marked as being visited, in the two side panes. */
  function currentBlocks(): string[] {
    return ['Ours (current branch)', 'Theirs (incoming)'].flatMap((side) =>
      [
        ...screen.getByRole('region', { name: side }).querySelectorAll('[data-current]'),
      ].map((element) => element.getAttribute('data-block') ?? ''),
    );
  }

  async function renderThree(): Promise<void> {
    readSides.mockResolvedValue(sides(THREE_OURS, THREE_THEIRS, THREE_BASE));
    renderResolver();
    await screen.findByRole('dialog');
    // The screen lands on the first conflict a tick after the blocks arrive.
    await screen.findByText(/^Conflict 1 of/);
  }

  it('opens standing on the first conflict rather than at the top of the file', async () => {
    // Hunting for the first disagreement by eye is the slowest part of the job,
    // and it is the same first step every single time.
    await renderThree();
    expect(screen.getByText('Conflict 1 of 3')).toBeInTheDocument();
    // One decision, two halves: the mark is on the block in both panes.
    expect(currentBlocks()).toEqual(['0', '0']);
  });

  it('walks forward through them, marking both halves of the one it is on', async () => {
    await renderThree();
    const next = screen.getByRole('button', { name: /Next/ });

    fireEvent.click(next);
    expect(screen.getByText('Conflict 2 of 3')).toBeInTheDocument();
    expect(currentBlocks()).toEqual(['1', '1']);

    fireEvent.click(next);
    expect(screen.getByText('Conflict 3 of 3')).toBeInTheDocument();
    expect(currentBlocks()).toEqual(['2', '2']);
  });

  it('stops at the ends instead of wrapping round without saying so', async () => {
    await renderThree();
    const next = screen.getByRole('button', { name: /Next/ });
    const previous = screen.getByRole('button', { name: /Previous/ });

    expect(previous).toBeDisabled();

    fireEvent.click(next);
    fireEvent.click(next);
    expect(screen.getByText('Conflict 3 of 3')).toBeInTheDocument();
    expect(next).toBeDisabled();

    fireEvent.click(previous);
    expect(screen.getByText('Conflict 2 of 3')).toBeInTheDocument();
  });

  it('walks past the blocks the merge already decided', async () => {
    // Only the middle line was touched by both sides; the other two are
    // one-sided edits, already applied. Stepping through them to reach the one
    // real question is exactly what this navigation exists to stop.
    readSides.mockResolvedValue(
      sides(
        'a\nmine1\nb\nmine2\nc\nmine3\nd\n',
        'a\nbase1\nb\nyours2\nc\nbase3\nd\n',
        THREE_BASE,
      ),
    );
    renderResolver();
    await screen.findByRole('dialog');

    expect(await screen.findByText('Conflict 1 of 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled();
    expect(currentBlocks()).toEqual(['1', '1']);
  });

  it('marks the visited block in the output too, once it has lines there', async () => {
    await renderThree();
    fireEvent.click(screen.getByRole('button', { name: /Take all from Ours/ }));

    // The Output is where the result is read, so it has to say which of its
    // runs the navigation is talking about.
    const marked = screen
      .getByLabelText('Output')
      .querySelectorAll('[data-current="true"]');
    expect(marked).toHaveLength(1);
    expect(marked[0]?.textContent).toContain('mine1');
  });

  it('offers nothing to walk when the sides do not disagree', async () => {
    readSides.mockResolvedValue(sides('same\n', 'same\n', 'same\n'));
    renderResolver();
    await screen.findByRole('dialog');

    expect(screen.getByText('nothing left to decide')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Previous/ })).toBeDisabled();
  });
});

describe('the three-way merge', () => {
  it('applies a change only one side made instead of asking about it', async () => {
    // Theirs moved, ours did not. There is nothing to choose between: the other
    // side has no opinion on those lines, and a checkbox next to "nothing on
    // this side" is a question with one answer.
    readSides.mockResolvedValue(sides(BASE, 'one\nyours\nthree\n', BASE));
    renderResolver();
    await screen.findByRole('dialog');

    expect(output()).toContain('yours');
    expect(screen.getByRole('button', { name: 'Save and mark resolved' })).toBeEnabled();
    expect(screen.getByText(/1 merged automatically/)).toBeInTheDocument();
  });

  it('says which boxes it ticked, and lets them be unticked', async () => {
    readSides.mockResolvedValue(sides(BASE, 'one\nyours\nthree\n', BASE));
    renderResolver();
    await screen.findByRole('dialog');

    // Once per pane: the tick is explained where it is, not in a legend.
    expect(screen.getAllByText('auto')).toHaveLength(2);
    expect(output()).toContain('yours');

    // The merge's answer is an offer, not a fact: unticking it drops those
    // lines exactly as unticking a hand-made choice does.
    fireEvent.click(block('Theirs (incoming)', 0));
    expect(output()).not.toContain('yours');
  });

  it('keeps a change both sides made identically, once', async () => {
    readSides.mockResolvedValue(sides('one\nboth\nthree\n', 'one\nboth\nthree\n', BASE));
    renderResolver();
    await screen.findByRole('dialog');

    // One run, not two: the change is in the file once, and it is decided.
    expect(output()).toContain('both');
    expect(screen.getAllByText('auto')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Save and mark resolved' })).toBeEnabled();
  });

  it('asks about everything when there is no ancestor to judge against', async () => {
    // add/add: both sides created the file. Nothing says whose edit is whose,
    // so nothing may be applied on the user's behalf.
    readSides.mockResolvedValue(addAdd('mine\n', 'yours\n'));
    renderResolver();
    await screen.findByRole('dialog');

    expect(screen.getByRole('button', { name: 'Save and mark resolved' })).toBeDisabled();
    expect(screen.queryByText('auto')).toBeNull();
  });
});

describe('editing the result', () => {
  /** The run of the Output holding `text`, ready to be double-clicked. */
  function run(text: string): HTMLElement {
    const found = [
      ...screen.getByLabelText('Output').querySelectorAll('[data-origin]'),
    ].find((element) => (element.textContent ?? '').includes(text));
    return found as HTMLElement;
  }

  async function editing(text: string): Promise<HTMLTextAreaElement> {
    fireEvent.doubleClick(run(text));
    return (await screen.findByLabelText(
      'Edit these lines of the result',
    )) as HTMLTextAreaElement;
  }

  it('opens a run for editing with exactly the lines it shows', async () => {
    renderResolver();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /Take all from Ours/ }));

    expect((await editing('mine')).value).toBe('mine');
  });

  it('writes what was typed into the file that gets saved', async () => {
    const store = renderResolver();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /Take all from Ours/ }));

    const box = await editing('mine');
    fireEvent.change(box, { target: { value: 'neither side\nbut this' } });
    fireEvent.blur(box);

    // The Output is the file, so an edit to it is an edit to what is written —
    // there is no second copy of the result to fall out of step.
    expect(output()).toContain('neither side');
    fireEvent.click(screen.getByRole('button', { name: 'Save and mark resolved' }));
    await waitFor(() => expect(resolveMock).toHaveBeenCalled());
    expect(resolveMock).toHaveBeenCalledWith(
      store,
      'src/app.ts',
      'one\nneither side\nbut this\nthree\n',
    );
  });

  it('can edit lines both sides already agreed on', async () => {
    renderResolver();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /Take all from Ours/ }));

    const box = await editing('three');
    fireEvent.change(box, { target: { value: 'THREE' } });
    fireEvent.blur(box);

    expect(output()).toContain('THREE');
    expect(output()).not.toContain('three');
  });

  it('throws the typing away on Escape without closing the screen', async () => {
    const store = renderResolver();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /Take all from Ours/ }));

    const box = await editing('mine');
    fireEvent.change(box, { target: { value: 'gone' } });
    fireEvent.keyDown(box, { key: 'Escape' });

    expect(output()).toContain('mine');
    expect(output()).not.toContain('gone');
    // Escape belongs to the box: cancelling a typo may not throw away the
    // whole resolution.
    expect(store.getState().resolving).toBe('src/app.ts');
  });

  it('marks the block it changed, because the panes no longer show the index', async () => {
    renderResolver();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /Take all from Ours/ }));

    const box = await editing('mine');
    fireEvent.change(box, { target: { value: 'mine, edited' } });
    fireEvent.blur(box);

    // Both halves of the block say so: the panes claim to show the index.
    expect(screen.getAllByText('edited')).toHaveLength(2);
  });
});

describe('the output pane', () => {
  /** The runs of the output, as [origin, text] pairs. */
  function runs(): [string, string][] {
    return [...screen.getByLabelText('Output').querySelectorAll('[data-origin]')].map(
      (element) => [element.getAttribute('data-origin') ?? '', element.textContent ?? ''],
    );
  }

  it('leaves agreed lines plain and marks what a choice put there', async () => {
    readSides.mockResolvedValue(sides(THREE_OURS, THREE_THEIRS, THREE_BASE));
    renderResolver();
    await screen.findByRole('dialog');

    fireEvent.click(block('Ours (current branch)', 0));

    // "What did I actually change?" is the question this pane is asked, and
    // only the decided run answers it.
    const decided = runs().filter(([origin]) => origin !== 'same');
    expect(decided).toHaveLength(1);
    expect(decided[0]?.[0]).toBe('ours');
    expect(decided[0]?.[1]).toContain('mine1');
    expect(runs().some(([origin, text]) => origin === 'same' && text.includes('a'))).toBe(
      true,
    );
  });

  it('marks both runs of a block kept from both sides, ours first', async () => {
    renderResolver();
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: 'Take both, everywhere' }));

    const decided = runs().filter(([origin]) => origin !== 'same');
    expect(decided.map(([origin]) => origin)).toEqual(['ours', 'theirs']);
    expect(decided[0]?.[1]).toContain('mine');
    expect(decided[1]?.[1]).toContain('yours');
  });

  it('colours nothing while the block is undecided', async () => {
    renderResolver();
    await screen.findByRole('dialog');

    // An undecided block contributes no lines at all, so there is nothing down
    // there to colour — the hole in the file is the honest signal.
    expect(runs().every(([origin]) => origin === 'same')).toBe(true);
  });

  it('marks each run with the side it came from, as the panes do', async () => {
    renderResolver();
    await screen.findByRole('dialog');

    // The colour that tells the two sides apart is driven by these, and the
    // panes above carry the same attribute — one line of association to learn,
    // not two vocabularies.
    fireEvent.click(screen.getByRole('button', { name: 'Take both, everywhere' }));

    const sideOf = (region: string): (string | null)[] =>
      [
        ...screen.getByRole('region', { name: region }).querySelectorAll('[data-block]'),
      ].map((element) => element.getAttribute('data-side'));
    expect(sideOf('Ours (current branch)')).toEqual(['ours']);
    expect(sideOf('Theirs (incoming)')).toEqual(['theirs']);
    expect(
      runs()
        .filter(([origin]) => origin !== 'same')
        .map(([origin]) => origin),
    ).toEqual(['ours', 'theirs']);
  });

  it('can be resized against the two sides', async () => {
    renderResolver();
    await screen.findByRole('dialog');

    const edge = screen.getByRole('separator', { name: 'Resize the output' });
    expect(edge).toHaveAttribute('aria-orientation', 'horizontal');
    expect(edge).toHaveAttribute('tabindex', '0');
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
