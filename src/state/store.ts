/**
 * The application store.
 *
 * Deliberately not React: a plain observable object with pure reducers, so
 * every state transition is unit-testable without rendering anything. Views
 * subscribe through `useStore` (see `hooks.ts`) and stay thin.
 */

import type { AppConfig } from '../config/schema';
import { defaultConfig } from '../config/schema';
import type {
  Branch,
  Commit,
  FileDiff,
  Remote,
  RepoInfo,
  RepoStatus,
  StashEntry,
} from '../git/types';
import { noOperation, type Operation } from '../git/operation';
import type { WorktreeSummary } from '../git/worktrees';

/** Every panel is in exactly one of these states — no silent blank screens. */
export type Loadable<T> =
  | { state: 'idle' }
  | { state: 'loading' }
  /** `stale` marks a value that is being re-read and is about to be replaced. */
  | { state: 'ready'; value: T; stale?: boolean }
  | { state: 'error'; message: string; kind?: string };

export function idle<T>(): Loadable<T> {
  return { state: 'idle' };
}

/**
 * The state a panel enters when it starts re-reading.
 *
 * A panel that already has an answer keeps showing it, marked stale, instead of
 * dropping to `loading`. Every write — a pull, a commit, a stage, or the file
 * watcher noticing an editor save — re-reads several panels at once, and
 * blanking them all turns a two-second fetch into the whole window reloading,
 * with the history, the diff and the branch list all disappearing and coming
 * back. The user asked for a pull; they did not ask to lose their place.
 *
 * A panel with nothing to show still goes to `loading`: that is a first load,
 * and there the spinner is the honest answer.
 */
function reloading<T>(previous: Loadable<T>): Loadable<T> {
  return previous.state === 'ready'
    ? { state: 'ready', value: previous.value, stale: true }
    : { state: 'loading' };
}

export interface Selection {
  /** Commit currently selected in the history, or `null` for the working tree. */
  commitOid: string | null;
  /** Path selected within the current diff, or `null` for "all files". */
  path: string | null;
}

/**
 * A message the user must be able to read *after* the operation finished —
 * notably the stash label a discard leaves behind, which is the only way back
 * to the discarded work.
 */
export interface Notice {
  /**
   * Monotonic id. A panel that reads a notice back to learn why its own call
   * failed must be able to tell "the notice I caused" from "a notice another
   * panel raised in the meantime" — comparing message text cannot do that,
   * because two panels can fail identically.
   */
  id: number;
  tone: 'info' | 'warning' | 'error';
  message: string;
  /** Command the user can run to undo, when one exists. */
  undoHint?: string;
}

/** What a caller supplies; the store stamps the id. */
export type NoticeInput = Omit<Notice, 'id'>;

export interface AppState {
  config: AppConfig;
  repo: Loadable<RepoInfo>;
  status: Loadable<RepoStatus>;
  commits: Loadable<Commit[]>;
  diff: Loadable<FileDiff[]>;
  branches: Loadable<Branch[]>;
  /**
   * Read from `git remote`, not reconstructed from remote-tracking branches: a
   * remote that has never been fetched from has no tracking refs at all, and
   * inferring the list from branches makes it invisible in the publish picker.
   */
  remotes: Loadable<Remote[]>;
  stashes: Loadable<StashEntry[]>;
  /**
   * The repository's other checkouts, with what is uncommitted in each.
   *
   * Read with one `git status` per worktree rather than inferred: nothing the
   * filesystem watcher hears about *this* checkout says a word about theirs.
   */
  worktrees: Loadable<WorktreeSummary[]>;
  /**
   * The merge, rebase, cherry-pick or revert the repository is stopped in the
   * middle of. Not derived from the conflict list: a rebase can stop with no
   * conflicts at all — an `edit` step, or a commit that became empty — and a UI
   * that keys off conflicts shows nothing while the repository sits detached
   * mid-rebase.
   */
  operation: Operation;
  /**
   * Path the conflict resolver is open on, or `null`.
   *
   * In the store rather than in a component because two places open it — the
   * banner at the top and the conflicted rows on the right — and the screen
   * itself is mounted at the top of the app, above both of them.
   */
  resolving: string | null;
  /** Last thing a write operation did, shown until the user moves on. */
  notice: Notice | null;
  selection: Selection;
  /**
   * How many repository-changing commands are in flight.
   *
   * A counter rather than a flag: with a boolean, two overlapping operations
   * clear it when the *first* finishes, re-enabling every destructive control
   * while the second is still writing.
   */
  busyDepth: number;
}

export function initialState(): AppState {
  return {
    config: defaultConfig(),
    repo: idle(),
    status: idle(),
    commits: idle(),
    diff: idle(),
    branches: idle(),
    remotes: idle(),
    stashes: idle(),
    worktrees: idle(),
    operation: noOperation(),
    resolving: null,
    notice: null,
    selection: { commitOid: null, path: null },
    busyDepth: 0,
  };
}

export type Action =
  | { type: 'config/loaded'; config: AppConfig }
  | { type: 'repo/opening' }
  | { type: 'repo/opened'; repo: RepoInfo }
  | { type: 'repo/failed'; message: string; kind?: string }
  | { type: 'repo/closed' }
  | { type: 'status/loading' }
  | { type: 'status/loaded'; status: RepoStatus }
  | { type: 'status/failed'; message: string; kind?: string }
  | { type: 'commits/loading' }
  | { type: 'commits/loaded'; commits: Commit[] }
  | { type: 'commits/failed'; message: string; kind?: string }
  | { type: 'diff/loading' }
  | { type: 'diff/loaded'; files: FileDiff[] }
  | { type: 'diff/failed'; message: string; kind?: string }
  | { type: 'branches/loading' }
  | { type: 'branches/loaded'; branches: Branch[] }
  | { type: 'branches/failed'; message: string; kind?: string }
  | { type: 'remotes/loading' }
  | { type: 'remotes/loaded'; remotes: Remote[] }
  | { type: 'remotes/failed'; message: string; kind?: string }
  | { type: 'stashes/loading' }
  | { type: 'stashes/loaded'; stashes: StashEntry[] }
  | { type: 'stashes/failed'; message: string; kind?: string }
  | { type: 'worktrees/loading' }
  | { type: 'worktrees/loaded'; worktrees: WorktreeSummary[] }
  | { type: 'worktrees/failed'; message: string; kind?: string }
  | { type: 'operation/read'; operation: Operation }
  | { type: 'resolve/open'; path: string }
  | { type: 'resolve/closed' }
  | { type: 'notice'; notice: NoticeInput | null }
  | { type: 'selection/commit'; oid: string | null }
  | { type: 'selection/path'; path: string | null }
  | { type: 'busy'; busy: boolean };

/** True while any repository-changing command is running. */
export function isBusy(state: AppState): boolean {
  return state.busyDepth > 0;
}

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'config/loaded':
      return { ...state, config: action.config };

    case 'repo/opening':
      return { ...state, repo: { state: 'loading' } };
    case 'repo/opened':
      // Opening a repository resets everything derived from the old one, so a
      // stale commit list can never be shown against the new repo.
      return {
        ...initialState(),
        config: state.config,
        repo: { state: 'ready', value: action.repo },
      };
    case 'repo/failed':
      return {
        ...initialState(),
        config: state.config,
        repo: { state: 'error', message: action.message, ...kindOf(action.kind) },
      };
    case 'repo/closed':
      return { ...initialState(), config: state.config };

    case 'status/loading':
      return { ...state, status: reloading(state.status) };
    case 'status/loaded':
      return { ...state, status: { state: 'ready', value: action.status } };
    case 'status/failed':
      return {
        ...state,
        status: { state: 'error', message: action.message, ...kindOf(action.kind) },
      };

    case 'commits/loading':
      return { ...state, commits: reloading(state.commits) };
    case 'commits/loaded':
      return { ...state, commits: { state: 'ready', value: action.commits } };
    case 'commits/failed':
      return {
        ...state,
        commits: { state: 'error', message: action.message, ...kindOf(action.kind) },
      };

    case 'diff/loading':
      return { ...state, diff: reloading(state.diff) };
    case 'diff/loaded':
      return { ...state, diff: { state: 'ready', value: action.files } };
    case 'diff/failed':
      return {
        ...state,
        diff: { state: 'error', message: action.message, ...kindOf(action.kind) },
      };

    case 'branches/loading':
      return { ...state, branches: reloading(state.branches) };
    case 'branches/loaded':
      return { ...state, branches: { state: 'ready', value: action.branches } };
    case 'branches/failed':
      return {
        ...state,
        branches: { state: 'error', message: action.message, ...kindOf(action.kind) },
      };

    case 'remotes/loading':
      return { ...state, remotes: reloading(state.remotes) };
    case 'remotes/loaded':
      return { ...state, remotes: { state: 'ready', value: action.remotes } };
    case 'remotes/failed':
      return {
        ...state,
        remotes: { state: 'error', message: action.message, ...kindOf(action.kind) },
      };

    case 'stashes/loading':
      return { ...state, stashes: reloading(state.stashes) };
    case 'stashes/loaded':
      return { ...state, stashes: { state: 'ready', value: action.stashes } };
    case 'stashes/failed':
      return {
        ...state,
        stashes: { state: 'error', message: action.message, ...kindOf(action.kind) },
      };

    case 'worktrees/loading':
      return { ...state, worktrees: reloading(state.worktrees) };
    case 'worktrees/loaded':
      return { ...state, worktrees: { state: 'ready', value: action.worktrees } };
    case 'worktrees/failed':
      return {
        ...state,
        worktrees: { state: 'error', message: action.message, ...kindOf(action.kind) },
      };

    case 'operation/read':
      return { ...state, operation: action.operation };

    case 'resolve/open':
      return { ...state, resolving: action.path };
    case 'resolve/closed':
      return { ...state, resolving: null };

    case 'notice':
      return {
        ...state,
        notice: action.notice === null ? null : { ...action.notice, id: nextNoticeId() },
      };

    case 'selection/commit':
      // Changing what is selected invalidates the diff shown for the old
      // selection; leaving it would attribute one commit's changes to another.
      return {
        ...state,
        selection: { commitOid: action.oid, path: null },
        diff: idle(),
      };
    case 'selection/path':
      return { ...state, selection: { ...state.selection, path: action.path } };

    case 'busy':
      return {
        ...state,
        // Never below zero: an unbalanced release would otherwise leave the
        // counter negative and the controls permanently enabled.
        busyDepth: Math.max(0, state.busyDepth + (action.busy ? 1 : -1)),
      };
  }
}

let noticeCounter = 0;

/** Ids are process-wide and never reused, so an id identifies one dispatch. */
function nextNoticeId(): number {
  noticeCounter += 1;
  return noticeCounter;
}

function kindOf(kind: string | undefined): { kind?: string } {
  return kind === undefined ? {} : { kind };
}

export type Listener = (state: AppState) => void;

export interface Store {
  getState(): AppState;
  dispatch(action: Action): void;
  subscribe(listener: Listener): () => void;
}

export function createStore(state: AppState = initialState()): Store {
  let current = state;
  const listeners = new Set<Listener>();

  return {
    getState: () => current,
    dispatch(action) {
      const next = reduce(current, action);
      if (next === current) return;
      current = next;
      for (const listener of [...listeners]) listener(current);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
