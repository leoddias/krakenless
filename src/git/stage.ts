import {
  buildApplyCachedCommand,
  buildApplyCheckCommand,
  buildCommitCommand,
  buildDiscardCommand,
  buildStageCommand,
  buildUnstageCommand,
  type CommitOptions,
} from './commands/stage';
import { pathspec } from './argsafety';
import { recoveryFor, unrecoverableNote } from './recovery';
import type { Confirmation } from './confirm';
import { GitError } from './errors';
import { serializeHunks } from './patch';
import { runGit } from './runner';
import type { FileDiff, Hunk } from './types';

/**
 * Turns a caller-supplied {@link Confirmation} into the runner's gate.
 *
 * Every destructive function here takes one. The token can only be minted by
 * the code that actually asked the user (`userConfirmed`), so the gate cannot
 * be satisfied by a module-level constant the way it was before.
 */
function approved(confirmation: Confirmation): { confirmed: true } {
  if (confirmation.reason.length === 0) {
    throw new GitError('needs-confirmation', 'Confirmation is missing its reason');
  }
  return { confirmed: true };
}

/** Staging is recoverable, so it needs no confirmation. */
export function stagePaths(repo: string, paths: string[]): Promise<unknown> {
  return runGit(repo, buildStageCommand(paths), { confirmed: true });
}

/** Unstaging only rewrites the index; the working tree keeps the edits. */
export function unstagePaths(repo: string, paths: string[]): Promise<unknown> {
  return runGit(repo, buildUnstageCommand(paths), { confirmed: true });
}

/**
 * Stages or unstages selected hunks.
 *
 * Two-step on purpose: `git apply --check` first, then the real apply. A patch
 * that would only partially apply is refused before it can touch the index, so
 * the failure mode is "nothing happened" rather than "half of your selection
 * was staged and the rest silently vanished".
 */
export async function applyHunks(
  repo: string,
  file: FileDiff,
  hunks: Hunk[],
  options: { reverse: boolean },
): Promise<void> {
  const patch = serializeHunks(file, hunks);
  // `--unidiff-zero` turns off git's context safety check, so it is only passed
  // when a hunk genuinely has no context lines to check against.
  const zeroContext = hunks.some((hunk) =>
    hunk.lines.every((line) => line.kind !== 'context'),
  );

  try {
    await runGit(repo, buildApplyCheckCommand({ ...options, zeroContext }), {
      confirmed: true,
      stdin: patch,
    });
  } catch (error) {
    if (error instanceof GitError) {
      throw new GitError(
        'command-failed',
        'This selection no longer matches the file. Refresh and try again.',
        { args: error.args, code: error.code, stderr: error.stderr },
      );
    }
    throw error;
  }

  await runGit(repo, buildApplyCachedCommand({ ...options, zeroContext }), {
    confirmed: true,
    stdin: patch,
  });
}

export function commit(repo: string, options: CommitOptions): Promise<unknown> {
  return runGit(repo, buildCommitCommand(options), { confirmed: true });
}

/** Amending rewrites the last commit, so the caller must have asked. */
export function amendCommit(
  repo: string,
  options: CommitOptions,
  confirmation: Confirmation,
): Promise<unknown> {
  return runGit(
    repo,
    buildCommitCommand({ ...options, amend: true }),
    approved(confirmation),
  );
}

export interface DiscardResult {
  /** False when git created no stash; nothing was discarded. */
  discarded: boolean;
  /** Message of the stash(es) holding the discarded changes, when any were made. */
  stashLabel?: string;
  /** Exact commands that bring the changes back, in order. */
  undoCommands: string[];
  /** Anything the commands above cannot restore, said plainly. */
  notes?: string[];
}

/** Resolves the current stash tip, or null when there are no stashes. */
async function stashTip(repo: string): Promise<string | null> {
  const output = await runGit(
    repo,
    { args: ['rev-parse', '--verify', '--quiet', 'refs/stash'] },
    { allowExitCodes: [1] },
  );
  const oid = output.stdout.trim();
  return oid.length === 0 ? null : oid;
}

/**
 * Splits the requested paths into what git actually needs discarding.
 *
 * Derived here, never taken from the caller: `keepIndex` is the only thing
 * standing between a discard and losing a staged snapshot, and a tracked path
 * mistakenly passed as untracked would lose it silently, exit 0, no warning.
 * Paths whose worktree side matches the index are dropped entirely — stashing
 * those creates an entry and changes nothing, so the user would be told their
 * changes were discarded while the file sits untouched.
 */
async function planDiscard(
  repo: string,
  paths: string[],
): Promise<{ tracked: string[]; untracked: string[] }> {
  const listed = await runGit(repo, { args: ['ls-files', '-z', ...pathspec(paths)] });
  const tracked = new Set(
    listed.stdout.split('\u0000').filter((path) => path.length > 0),
  );

  // Worktree-vs-index differences: exactly the paths a discard would change.
  const dirty = await runGit(repo, {
    args: ['diff', '--name-only', '-z', ...pathspec(paths)],
  });
  const changed = new Set(dirty.stdout.split('\u0000').filter((path) => path.length > 0));

  return {
    tracked: paths.filter((path) => tracked.has(path) && changed.has(path)),
    untracked: paths.filter((path) => !tracked.has(path)),
  };
}

/** What one stash phase produced, once it is known to have created an entry. */
interface StashedPhase {
  /** The stash entry itself, for `git stash show` and for naming it. */
  stashOid: string;
  /** Oid whose *tree* holds the content — the third parent for untracked. */
  sourceOid: string;
  /** Paths that tree actually contains. */
  presentPaths: string[];
  /** Paths the phase was asked to discard. */
  requestedPaths: string[];
}

/**
 * Resolves where a phase's content really lives, and what is in it.
 *
 * `stash push --include-untracked` stores untracked files in the stash's third
 * parent, not its tree (verified against git 2.39), so restoring from the stash
 * oid would fail for exactly the case where the file exists nowhere else.
 */
async function describeStash(
  repo: string,
  stashOid: string,
  requestedPaths: string[],
  untracked: boolean,
): Promise<StashedPhase> {
  let sourceOid = stashOid;
  if (untracked) {
    const parent = await runGit(
      repo,
      { args: ['rev-parse', '--verify', '--quiet', `${stashOid}^3`] },
      { allowExitCodes: [1] },
    );
    const resolved = parent.stdout.trim();
    // Resolved to a literal oid on purpose: `^` is an escape character in
    // cmd.exe, so a copy-pasted `--source=<oid>^3` silently loses the `^3`.
    if (resolved.length > 0) sourceOid = resolved;
  }

  // Scoped to the paths asked about. Listing the whole tree would walk every
  // file in the repository, and one undecodable name anywhere in it would make
  // the runner throw `undecodable-output` *after* the stash already took the
  // work off disk — leaving no oid to recover from.
  const listed = await runGit(repo, {
    args: ['ls-tree', '-r', '-z', '--name-only', sourceOid, '--', ...requestedPaths],
  });
  return {
    stashOid,
    sourceOid,
    presentPaths: listed.stdout.split('\u0000').filter((path) => path.length > 0),
    requestedPaths,
  };
}

/**
 * Runs one stash phase and describes what it created, if anything.
 *
 * A failure still has to report the stash: `stash push` can fail *after*
 * stashing a file and removing it from disk, and losing that oid to an
 * exception means the file is gone with no route back.
 */
async function stashAway(
  repo: string,
  paths: string[],
  label: string,
  keepIndex: boolean,
  gate: { confirmed: true },
): Promise<StashedPhase | null> {
  if (paths.length === 0) return null;
  const before = await stashTip(repo);

  try {
    await runGit(repo, buildDiscardCommand(paths, label, { keepIndex }), gate);
  } catch (error) {
    const created = await stashTip(repo);
    if (created !== null && created !== before) {
      throw new StashedButFailed(await describeStash(repo, created, paths, !keepIndex));
    }
    throw error;
  }

  // `git stash push -- <path>` exits 0 and creates nothing when there is
  // nothing to save; reporting a recovery route then would point at an
  // unrelated, older entry.
  const after = await stashTip(repo);
  if (after === null || after === before) return null;
  return describeStash(repo, after, paths, !keepIndex);
}

/** Carries a phase's stash out of a failure so the undo route survives. */
class StashedButFailed extends Error {
  readonly phase: StashedPhase;

  constructor(phase: StashedPhase) {
    super('The discard failed after stashing');
    this.name = 'StashedButFailed';
    this.phase = phase;
  }
}

function collectRecovery(phase: StashedPhase): { commands: string[]; notes: string[] } {
  const plan = recoveryFor(phase.sourceOid, phase.requestedPaths, phase.presentPaths);
  const note = unrecoverableNote(phase.stashOid, plan.unrecoverable);
  return { commands: plan.commands, notes: note === null ? [] : [note] };
}

/**
 * Discards working-tree changes for the given paths.
 *
 * `--keep-index` on the tracked half protects a staged snapshot: without it the
 * stash reverts staged content to HEAD too, and nothing puts that back. Git
 * 2.39 rejects that flag together with an untracked pathspec, so untracked
 * paths go into their own stash — they have no index entry to protect anyway.
 */
export async function discardPaths(
  repo: string,
  paths: string[],
  confirmation: Confirmation,
): Promise<DiscardResult> {
  const gate = approved(confirmation);
  const stashLabel = `krakenless: discarded ${new Date().toISOString()}`;
  const plan = await planDiscard(repo, paths);

  const undoCommands: string[] = [];
  const notes: string[] = [];
  const absorb = (phase: StashedPhase | null): void => {
    if (phase === null) return;
    const recovery = collectRecovery(phase);
    undoCommands.push(...recovery.commands);
    notes.push(...recovery.notes);
  };

  try {
    absorb(await stashAway(repo, plan.tracked, stashLabel, true, gate));
    absorb(await stashAway(repo, plan.untracked, stashLabel, false, gate));
  } catch (error) {
    // Work may already be off disk. Whatever went wrong, the routes back that
    // earlier phases earned must travel with the error, not be dropped with it.
    if (error instanceof StashedButFailed) absorb(error.phase);
    if (undoCommands.length === 0 && notes.length === 0) throw error;

    throw new GitError(
      'command-failed',
      [
        'The discard failed partway, and some changes are already in a stash.',
        ...undoCommands.map((command) => `Recover with: ${command}`),
        ...notes,
      ].join(' '),
      { args: ['stash', 'push'] },
    );
  }

  if (undoCommands.length === 0 && notes.length === 0) {
    return { discarded: false, undoCommands: [] };
  }
  return { discarded: true, stashLabel, undoCommands, notes };
}
