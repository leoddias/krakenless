import {
  buildApplyCachedCommand,
  buildApplyCheckCommand,
  buildBackupBlobCommand,
  buildCommitCommand,
  buildDiscardCommand,
  buildDiscardHunkCheckCommand,
  buildDiscardHunkCommand,
  buildReadBlobCommand,
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
  const zeroContext = hasZeroContext(hunks);

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

/**
 * True for a hunk with no context lines, which is the only case where
 * `--unidiff-zero` may be passed. Shared so the check and the real apply can
 * never disagree about it — a dry run made under different rules proves
 * nothing about the apply that follows.
 */
function hasZeroContext(hunks: Hunk[]): boolean {
  // `every`, not `some`. `--unidiff-zero` is a per-*patch* flag: with `some`,
  // a single context-free hunk would turn off git's position check for every
  // other hunk in the same patch, and on the worktree path that means a
  // reverse patch landing blind at a stated line number.
  return hunks.every((hunk) => hunk.lines.every((line) => line.kind !== 'context'));
}

export interface HunkDiscardResult {
  /** Oid of the file's bytes as they were a moment before the discard. */
  blobOid: string;
  /** The path those bytes belong to. */
  path: string;
}

/**
 * File shapes a hunk discard must refuse, or `null` when it may proceed.
 *
 * Checked in the git layer and not only in the UI: the buttons are one caller,
 * and a guard that lives only next to them protects only them.
 */
export function discardHunkRefusal(file: FileDiff): string | null {
  if (file.side !== 'unstaged') {
    return 'Only unstaged hunks can be discarded; unstage this one first.';
  }
  if (file.newMode === '120000' || file.oldMode === '120000') {
    // A symlink's patch body is the link target. Restoring it by writing that
    // text to the path would follow the link and overwrite whatever it points
    // at — a file outside the repository that the user never selected.
    return 'A symlink cannot be discarded hunk by hunk; discard the whole file.';
  }
  if (file.kind === 'type-changed') {
    return 'This path changed type; discard the whole file instead.';
  }
  if (file.kind === 'added') {
    // Reverse-applying a `new file mode` patch deletes the file from disk,
    // which is not what "put these lines back" describes.
    return 'This file is new to git; discarding a hunk of it would delete it.';
  }
  if (file.kind === 'deleted') {
    return 'This file is already gone from disk; restore the whole file instead.';
  }
  return null;
}

/**
 * Discards one file's selected hunks from the working tree.
 *
 * This is the only operation in the app that destroys content git has never
 * been told about, so the file's bytes are written into the object store
 * *first*, and a backup that does not produce an oid aborts the discard rather
 * than proceeding unprotected.
 *
 * The route back is the returned oid, which the app keeps and can write back
 * itself. It is deliberately **not** a shell command: `git cat-file -p <oid> >
 * path` is byte-exact in `cmd.exe` and `pwsh`, but in Windows PowerShell 5.1 —
 * still the default shell on Windows 11 — `>` is `Out-File`, which re-encodes
 * the stream as UTF-16LE with a BOM and appends a newline. Printing that
 * command would have handed the user a "recovery" that corrupts the file it
 * claims to restore.
 *
 * Restoring rewrites the whole file, not just the discarded hunks, because
 * that is the state that actually existed and can be described honestly.
 *
 * `--check` runs before the real apply for the same reason as `applyHunks`: a
 * selection built from a diff the file has since moved past must change
 * nothing rather than land partway.
 */
export async function discardHunks(
  repo: string,
  file: FileDiff,
  hunks: Hunk[],
  confirmation: Confirmation,
): Promise<HunkDiscardResult> {
  const gate = approved(confirmation);
  const refusal = discardHunkRefusal(file);
  if (refusal !== null) {
    throw new GitError('command-failed', refusal, { args: ['apply', '--reverse'] });
  }

  // `'worktree'`: the reverse patch is matched against the new side and must
  // carry no file-level mode lines. See `PatchTarget`.
  const patch = serializeHunks(file, hunks, 'worktree');
  const zeroContext = hasZeroContext(hunks);

  // Before anything is applied: once the reverse patch lands, these bytes exist
  // nowhere else.
  const backup = await runGit(repo, buildBackupBlobCommand(file.newPath), gate);
  const blobOid = backup.stdout.trim();
  // Exactly a sha1 or a sha256 oid; the lengths in between are not real.
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(blobOid)) {
    throw new GitError(
      'parse-failed',
      'Could not back the file up before discarding, so nothing was discarded.',
      { args: ['hash-object'] },
    );
  }

  try {
    await runGit(repo, buildDiscardHunkCheckCommand({ zeroContext }), {
      ...gate,
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

  await runGit(repo, buildDiscardHunkCommand({ zeroContext }), {
    ...gate,
    stdin: patch,
  });

  return { blobOid, path: file.newPath };
}

/**
 * Reads a backup blob's contents back out of the object store.
 *
 * The undo for a hunk discard. Goes through the runner like everything else,
 * so a blob whose bytes are not valid UTF-8 fails loudly rather than being
 * written back with replacement characters where the original had bytes.
 */
export async function readBackupBlob(repo: string, blobOid: string): Promise<string> {
  const output = await runGit(repo, buildReadBlobCommand(blobOid));
  return output.stdout;
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
