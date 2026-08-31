/**
 * Shared contract for the git layer.
 *
 * These types are the seam between command builders, parsers, and the UI.
 * They are deliberately dumb data — no methods, no classes — so parsers stay
 * pure functions that are trivial to unit test (ADR-0008).
 */

/** A git invocation, ready to hand to the runner. Never a shell string. */
export interface GitCommand {
  /** Argument array, in order. Paths go after `--` where git supports it. */
  args: string[];
  /**
   * Set by builders for operations that can destroy work. The runner refuses
   * to execute these unless the caller passes an explicit confirmation.
   */
  destructive?: boolean;
  /** Overrides the runner's default timeout for slow operations (fetch, push). */
  timeoutMs?: number;
}

/** Raw result of running git, straight from the Rust shell. */
export interface GitOutput {
  stdout: string;
  stderr: string;
  /** `null` when the process was killed (signal or our timeout). */
  code: number | null;
  timedOut: boolean;
  /** True when stdout was not valid UTF-8 and had to be decoded lossily. */
  stdoutLossy: boolean;
}

export type GitErrorKind =
  | 'not-a-repository'
  | 'git-missing'
  | 'timeout'
  | 'bad-repo-path'
  | 'bad-argument'
  | 'needs-confirmation'
  | 'authentication'
  | 'conflict'
  | 'command-failed'
  | 'parse-failed'
  | 'undecodable-output';

// --- status -----------------------------------------------------------------

/** Per-side state of a path, as reported by `git status --porcelain=v2`. */
export type FileState =
  | 'unmodified'
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type-changed'
  | 'untracked'
  | 'ignored'
  | 'unmerged';

export interface StatusEntry {
  /** Repository-relative path, forward slashes, as git reports it. */
  path: string;
  /** Source path for renames and copies. */
  origPath?: string;
  /** State of the staged (index) side. */
  index: FileState;
  /** State of the working-tree side. */
  worktree: FileState;
  /** Rename/copy similarity score, 0–100, when git reports one. */
  similarity?: number;
  /** True while the path is in a conflicted (unmerged) state. */
  conflicted: boolean;
  /** Submodule marker from porcelain v2 (`SCMU`), when present. */
  submodule?: string;
  /**
   * Conflict type from a porcelain v2 `u` record, when the path is unmerged.
   * The UI needs it to offer the right resolution: `UU`/`AA` are content
   * conflicts, `DU`/`UD` are keep-vs-delete.
   */
  conflictKind?: 'DD' | 'AU' | 'UD' | 'UA' | 'DU' | 'AA' | 'UU';
}

export interface RepoStatus {
  /** Current branch name, or `null` when HEAD is detached. */
  branch: string | null;
  /** Commit HEAD points at; `null` in an empty repository. */
  head: string | null;
  detached: boolean;
  /** Upstream ref (e.g. `origin/main`), when the branch tracks one. */
  upstream?: string;
  /**
   * Commits ahead of / behind the upstream — `undefined` when git did not
   * report them (no `# branch.ab` record: `status.aheadBehind=false`, or the
   * remote-tracking ref is gone). Defaulting these to 0 would render as "up to
   * date" for a branch whose real relationship is unknown, and a push offered
   * on that basis is a decision made on a lie.
   */
  ahead?: number;
  behind?: number;
  entries: StatusEntry[];
  /** True while a merge/rebase/cherry-pick left conflicts in the tree. */
  hasConflicts: boolean;
}

// --- log --------------------------------------------------------------------

export type RefKind = 'head' | 'branch' | 'remote-branch' | 'tag';

export interface CommitRef {
  kind: RefKind;
  /** Short name as decorated by git (`main`, `origin/main`, `v1.0`). */
  name: string;
}

export interface Commit {
  oid: string;
  shortOid: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** ISO 8601 with offset, straight from `%aI`. */
  authorDate: string;
  committerName: string;
  committerDate: string;
  subject: string;
  body: string;
  refs: CommitRef[];
}

// --- diff -------------------------------------------------------------------

export type DiffLineKind = 'context' | 'added' | 'deleted' | 'no-newline';

export interface DiffLine {
  kind: DiffLineKind;
  /** Line content without the leading +/-/space marker. */
  text: string;
  /** 1-based line number on the old side, when the line exists there. */
  oldLine?: number;
  /** 1-based line number on the new side, when the line exists there. */
  newLine?: number;
}

export interface Hunk {
  /** The `@@ -a,b +c,d @@` line verbatim, including any trailing section text. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type FileChangeKind =
  'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'type-changed';

/**
 * Which comparison an entry came out of.
 *
 * Load-bearing, not a label. The diff panel concatenates the worktree and the
 * cached diff, so the same path can appear twice, and the *only* difference
 * between "stage this hunk" and "unstage this hunk" is which side produced it.
 * A button that guessed would move the wrong hunk in the wrong direction.
 */
export type DiffSide = 'unstaged' | 'staged' | 'commit';

/**
 * A file entry exactly as the parser read it out of a patch.
 *
 * The parser cannot know which comparison it is reading — the patch text is
 * identical either way — so the side is stamped on by the caller that chose
 * the command, in `src/git/diff.ts`.
 */
export interface ParsedFileDiff {
  oldPath: string;
  newPath: string;
  kind: FileChangeKind;
  binary: boolean;
  /**
   * True when git reported the path as conflicted (`diff --cc` or
   * `* Unmerged path`). Such an entry has no hunks and no appliable patch —
   * "no hunks" alone also describes a mode-only change or an empty new file,
   * which *must* be staged wholesale, so staging code has to switch on this.
   */
  conflicted: boolean;
  /**
   * File modes as git reported them, when it did. The patch serializer must
   * re-emit these: a patch that omits a mode change stages the content without
   * the exec bit, and one that guesses `100644` for a symlink stages a regular
   * file containing the link target.
   */
  oldMode?: string;
  newMode?: string;
  /** Raw `diff --git` header lines preceding the first hunk. */
  headerLines: string[];
  hunks: Hunk[];
}

export interface FileDiff extends ParsedFileDiff {
  side: DiffSide;
}

// --- refs, remotes, stash ---------------------------------------------------

export interface Branch {
  name: string;
  /** True for the branch HEAD currently points at. */
  current: boolean;
  oid: string;
  upstream?: string;
  ahead: number;
  behind: number;
  remote: boolean;
}

/**
 * One worktree attached to the repository.
 *
 * A worktree is a second checkout sharing one `.git`: its own files, its own
 * index, its own HEAD, the same commits and the same branches. Two of them can
 * never have the same branch checked out, which is what makes "who has this
 * branch open" a question the UI can answer.
 */
export interface Worktree {
  /** Absolute path of the checkout, exactly as git printed it. */
  path: string;
  /** Commit it has checked out; `null` for a worktree with no commits yet. */
  head: string | null;
  /** Branch it is on, without `refs/heads/`; `null` when detached or bare. */
  branch: string | null;
  detached: boolean;
  bare: boolean;
  /** Lock reason — `''` when locked without one, `null` when not locked. */
  locked: string | null;
  /** Why git considers it removable, or `null`. A missing directory is one. */
  prunable: string | null;
  /** True for the repository's own worktree, which git lists first. */
  main: boolean;
}

export interface Remote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface StashEntry {
  /** Ref of the entry, e.g. `stash@{0}`. */
  ref: string;
  /**
   * Commit the ref pointed at when the list was read. Indices shift whenever
   * anything is stashed, so every mutation re-checks this before acting.
   */
  oid: string;
  index: number;
  message: string;
  /** Branch the stash was taken on, when git recorded one. */
  branch?: string;
  date: string;
}

// --- repository-level state -------------------------------------------------

/** Mid-operation states that change which actions are safe to offer. */
export type RepoOperation =
  'none' | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';

export interface RepoInfo {
  /**
   * Absolute path to the working tree root. For a **bare** repository there is
   * no worktree, and this aliases `gitDir` — never run a worktree write with
   * it without checking `bare` first.
   */
  root: string;
  /** Absolute path to the `.git` directory or file. */
  gitDir: string;
  bare: boolean;
  /** True when the repository has no commits yet. */
  empty: boolean;
}
