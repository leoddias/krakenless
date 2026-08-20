# Active task board

Packets currently in flight or awaiting integration. Format and rules:
`docs/PARALLEL.md`. Empty between fan-outs — this is a scratch board, not
history; outcomes go to `docs/PROGRESS.md`.

## In flight

Fan-out 2 (M1 views). Shared contract — `src/state/store.ts`, `src/state/hooks.tsx`,
`src/state/actions.ts`, `src/config/**`, the whole `src/git/**` layer — is
committed and **read-only** for every packet. Views read state via `useAppState`
and act only through `src/state/actions.ts`; no view calls git directly.
Each packet owns one folder under `src/views/` plus its own CSS module, so no
two packets share a file. `src/App.tsx` and `src/main.tsx` belong to the
orchestrator: request wiring changes in your report.

### T-M1-4 — Welcome view

- **Goal:** first screen — pick a folder or reopen a recent repository.
- **Owns:** `src/views/welcome/**`
- **Done when:** folder picker via `@tauri-apps/plugin-dialog`; recent list from
  `state.config.recentRepos` with "forget"; opening dispatches `openRepo`;
  loading and error states (`not-a-repository`, `git-missing` get their own
  wording); keyboard reachable; tests with Testing Library over a real store.
- **Review:** conventions
- **Status:** running

### T-M1-5 — History view

- **Goal:** virtualized commit list with refs, selection driving the diff panel.
- **Owns:** `src/views/history/**`
- **Done when:** renders `state.commits` virtualized (no library — a windowed
  list is fine) and stays smooth at 200 rows; shows short oid, subject, author,
  relative date, and `CommitRef` decorations styled per kind; a "Working tree"
  row selects `null`; selection calls `selectCommit`; idle/loading/empty/error
  states; keyboard up/down navigation; tests over a real store.
- **Review:** conventions
- **Status:** running

### T-M1-6 — Diff view

- **Goal:** read-only diff panel for the current selection.
- **Owns:** `src/views/diff/**`
- **Done when:** renders `state.diff` — file list plus hunks with per-side line
  numbers, monospace, added/deleted/context styling; binary, conflicted,
  rename, mode-only and empty-hunk entries each say what they are rather than
  rendering blank; `undecodable-output` errors explain the file cannot be shown
  safely; idle/loading/empty/error states; tests over a real store.
- **Review:** conventions
- **Status:** running

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
