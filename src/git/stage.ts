import {
  buildApplyCachedCommand,
  buildApplyCheckCommand,
  buildBackupBlobCommand,
  buildBackupBlobsCommand,
  buildCommitCommand,
  buildDiscardHunkCheckCommand,
  buildDiscardHunkCommand,
  buildReadBlobCommand,
  buildRemoveUntrackedCommand,
  buildRestoreWorktreeCommand,
  buildStageCommand,
  buildUnstageCommand,
  type CommitOptions,
} from './commands/stage';
import { chunkPathspec } from './argsafety';
import { getStatus } from './status';
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

/** One file's bytes as they were a moment before the discard. */
export interface DiscardBackupRecord {
  path: string;
  blobOid: string;
}

export interface DiscardResult {
  /** False when nothing on the requested paths needed discarding. */
  discarded: boolean;
  /** One per file that had bytes on disk, taken before anything was removed. */
  backups: DiscardBackupRecord[];
  /**
   * Files that were deleted on disk and came back from the index. Nothing
   * to back up for those — there were no bytes — and nothing lost either.
   */
  restoredFromIndex: string[];
}

/** What the discard has to do, sorted by what git needs for each. */
interface DiscardPlan {
  /** Tracked, changed on disk, and still there. */
  tracked: string[];
  /** Tracked and gone from disk: `restore` brings them back, no backup needed. */
  deleted: string[];
  untracked: string[];
}

/**
 * Sorts the requested paths into what git actually needs doing.
 *
 * One status read over the whole tree rather than `ls-files` and `diff` over
 * the requested paths: neither accepts a pathspec on stdin, and a few thousand
 * untracked files — "Discard all" after a build — pushed the command line past
 * what Windows will start a process with. Paths whose working tree matches the
 * index are dropped: there is nothing to discard, and saying "discarded"
 * about them would be a lie.
 */
async function planDiscard(repo: string, paths: string[]): Promise<DiscardPlan> {
  const status = await getStatus(repo);
  const tracked = new Set<string>();
  const deleted = new Set<string>();
  const untracked = new Set<string>();
  for (const entry of status.entries) {
    if (entry.conflicted) continue;
    if (entry.worktree === 'untracked') untracked.add(entry.path);
    else if (entry.worktree === 'deleted') deleted.add(entry.path);
    else if (entry.worktree !== 'unmodified' && entry.worktree !== 'ignored') {
      tracked.add(entry.path);
    }
  }
  return {
    tracked: paths.filter((path) => tracked.has(path)),
    deleted: paths.filter((path) => deleted.has(path)),
    untracked: paths.filter((path) => untracked.has(path)),
  };
}

/** Exactly a sha1 or a sha256 oid; the lengths in between are not real. */
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Backs every file up, or backs nothing up.
 *
 * The oids come back one per line in the order the paths went in. A count
 * that does not match, or a line that is not an oid, means git did not do
 * what was asked, and a discard that proceeded on a partial backup would be
 * the unrecoverable discard this route exists to avoid.
 */
async function backUp(repo: string, paths: string[]): Promise<DiscardBackupRecord[]> {
  const output = await runGit(repo, buildBackupBlobsCommand(paths));
  const oids = output.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (oids.length !== paths.length || !oids.every((oid) => OID.test(oid))) {
    throw new GitError(
      'parse-failed',
      'Could not back the files up before discarding, so nothing was discarded.',
      { args: ['hash-object'] },
    );
  }
  return paths.map((path, index) => ({ path, blobOid: oids[index] ?? '' }));
}

/**
 * Discards working-tree changes for the given paths, keeping every file's
 * bytes as a blob first.
 *
 * Order is the whole design: back up, hand the records to the caller, *then*
 * remove. `onBackedUp` fires before the first destructive command, so a
 * restore or a clean that fails halfway cannot take the only route back with
 * it — the caller has already recorded the oids. Tracked files (and deleted
 * ones) go back to their index version with `restore --worktree`, which keeps
 * a staged snapshot exactly as it was; untracked files are removed with
 * `clean`, a chunk at a time because `clean` cannot read a long list.
 *
 * No stash. The earlier design stashed and printed a `git restore` command;
 * every discard left an entry in the stash list and a node on the graph, and
 * a stash push cannot take a long path list at all (ADR-0044). The blob route
 * is invisible, byte-exact, and undone with a button (ADR-0045).
 */
export async function discardPaths(
  repo: string,
  paths: string[],
  confirmation: Confirmation,
  hooks: { onBackedUp?: (backups: DiscardBackupRecord[]) => void } = {},
): Promise<DiscardResult> {
  const gate = approved(confirmation);
  const plan = await planDiscard(repo, paths);
  const present = [...plan.tracked, ...plan.untracked];
  if (present.length === 0 && plan.deleted.length === 0) {
    return { discarded: false, backups: [], restoredFromIndex: [] };
  }

  const backups = present.length === 0 ? [] : await backUp(repo, present);
  hooks.onBackedUp?.(backups);

  const toRestore = [...plan.tracked, ...plan.deleted];
  if (toRestore.length > 0) {
    await runGit(repo, buildRestoreWorktreeCommand(toRestore), gate);
  }
  for (const chunk of chunkPathspec(plan.untracked)) {
    await runGit(repo, buildRemoveUntrackedCommand(chunk), gate);
  }

  return { discarded: true, backups, restoredFromIndex: plan.deleted };
}
