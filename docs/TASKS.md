# Active task board

Packets currently in flight or awaiting integration. Format and rules:
`docs/PARALLEL.md`. Empty between fan-outs — this is a scratch board, not
history; outcomes go to `docs/PROGRESS.md`.

## In flight

_(none — fan-out 1 closed)_

<details><summary>Fan-out 1 (M1 parsers) — closed 2026-08-20</summary>

Fan-out 1 (M1 parsers). Shared contract — `src/git/types.ts`, `src/git/errors.ts`,
`src/git/runner.ts`, `src/git/argsafety.ts`, `src/git/destructive.ts`,
`src/git/repository.ts` — is committed (d487aa9) and **read-only** for every
packet. Builders must route user-named values through `argsafety.ts`.

### T-M1-1 — Status parser

- **Goal:** `git status --porcelain=v2 --branch -z` output becomes a typed `RepoStatus`.
- **Owns:** `src/git/commands/status.ts`, `src/git/parsers/status.ts`, `src/git/parsers/status.test.ts`, `src/git/status.ts`
- **Reads:** `src/git/types.ts`, `src/git/errors.ts`, `src/git/runner.ts`, `src/git/repository.ts`
- **Done when:** builder emits the exact args array; parser handles ordinary/renamed/copied/unmerged/untracked/ignored entries, detached HEAD, empty repo, no upstream, ahead/behind, paths with spaces and unicode, NUL-separated records; malformed input throws `GitError('parse-failed')`; unit tests cover each of those.
- **Review:** conventions+safety
- **Status:** merged

### T-M1-2 — Log parser

- **Goal:** `git log` with an explicit `--format` separator becomes `Commit[]`.
- **Owns:** `src/git/commands/log.ts`, `src/git/parsers/log.ts`, `src/git/parsers/log.test.ts`, `src/git/log.ts`
- **Reads:** same as T-M1-1
- **Done when:** builder uses an ASCII-control separator (never a character that can appear in a commit message) and supports limit/skip/all-refs; parser fills every `Commit` field, splits parents, parses `%D` decorations into typed `CommitRef[]` (HEAD, branch, remote branch, tag, HEAD -> branch), handles multi-line bodies, empty bodies, root commits, merge commits, unicode and CRLF; malformed input throws `GitError('parse-failed')`; unit tests cover each.
- **Review:** conventions+safety
- **Status:** merged

### T-M1-3 — Diff parser

- **Goal:** unified diff text becomes `FileDiff[]` with hunks and per-side line numbers.
- **Owns:** `src/git/commands/diff.ts`, `src/git/parsers/diff.ts`, `src/git/parsers/diff.test.ts`, `src/git/diff.ts`
- **Reads:** same as T-M1-1
- **Done when:** builders exist for worktree diff, staged diff, and `git show` of one commit, all with `--no-color`, `--no-ext-diff`, `-U3`, and paths after `--`; parser handles multiple files in one output, added/deleted/renamed/copied/mode-change/binary files, multiple hunks, `\ No newline at end of file`, hunk headers with a trailing function name, paths with spaces and quoted paths, CRLF; line numbers are correct on both sides; malformed input throws `GitError('parse-failed')`; unit tests cover each.
- **Review:** conventions+safety
- **Status:** merged

</details>

## Merged this session

Fan-out 1 (M1 parsers) — all three packets merged into `main`:

- T-M1-1 status parser — merged, 3 worker commits, safety verdict SAFE TO HANDOFF.
- T-M1-2 log parser — merged, 3 worker commits; the record separator was changed
  from `%x1e` to NUL after its reviewer proved a commit body could forge a whole
  fake commit (with a decoration) into the parsed history.
- T-M1-3 diff parser — merged, 3 worker commits; submodule flags pinned after a
  critical finding that submodule changes were misattributed or dropped.

Shared-file edits applied by the orchestrator on the workers' request:
`--literal-pathspecs` + `i18n.logOutputEncoding=UTF-8` in the Rust global args,
`StatusEntry.conflictKind`, `FileDiff.conflicted`, `node` in tsconfig types.
