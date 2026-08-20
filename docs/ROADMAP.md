# Roadmap

Budget: ~5–10 h/week. v0.1 target: 4–6 weeks from first code.
Scope authority: `PLAN.md`. Check items off as they land (with tests).
If schedule slips: cut graph *polish*, never parser tests.

## v0.1 — dogfood build

### M0 — Scaffold (~1 session)
- [x] Tauri 2 + React + TypeScript + Vite project
- [x] oxlint + Prettier, strict tsconfig (ADR-0014 — oxlint replaces ESLint)
- [x] Vitest wired (one trivial passing test)
- [x] `.gitignore` covers node/rust/tauri artifacts
- [x] GitHub Actions: lint + test + Windows build on push
- [x] App opens an empty window with app name; setup, dev + build scripts
      documented in README

### M1 — Read-only repo view (~1–2 weeks)
- [x] Git layer skeleton: run `git` with args array (never string interpolation),
      capture stdout/stderr/exit code, timeout handling
- [x] Detect valid repo; graceful error for non-repo folder
- [x] Welcome screen: recent repos (JSON config in `%APPDATA%/krakenless`) + folder picker
- [x] Parse `git status --porcelain=v2 --branch` → typed model (unit tests)
- [x] Parse `git log` with explicit `--format` separator → commit list (unit tests)
- [x] Commit list UI (virtualized) with branch/tag/HEAD decorations
- [x] Diff viewer: `git diff` / `git show` parsed and rendered read-only (unit tests)
- [x] Loading / empty / error states for every panel

### M2 — Staging + commit (~1–2 weeks; hardest milestone)
- [x] Stage/unstage whole files (`git add` / `git restore --staged`) (integration tests)
- [x] Hunk model: parse unified diff into hunks (unit tests)
- [x] Stage/unstage hunk via `git apply --cached [-R]` round-trip (integration tests on temp repos)
- [x] Commit message editor + commit + amend
- [x] Discard changes — confirm dialog, recoverable form (path-limited stash with `--keep-index`) (integration tests)
- [x] Working tree auto-refresh (fs watcher, debounced)

### M3 — Remotes (~1 week)
- [x] Fetch / pull / push with progress and readable error surfaces
- [x] Ahead/behind indicators (honest: unknown when git did not report them)
- [x] Conflict detection → honest banner: conflicted files list, "Open in editor",
      "Open git mergetool", "Abort merge"

### M4 — Branches + stash (~1 week)
- [x] Create / checkout / delete branch (delete = confirm; prefer `-d`, explicit `-D`)
- [x] Stash push / pop / list
- [x] Graph edges between commits (parent lines) — functional, not beautiful

### M5 — Polish + dogfood gate (~1 week)
- [x] Keyboard navigation (Ctrl+1..4, Ctrl+R/F5, Ctrl+Enter, Ctrl+, Ctrl+W),
      focus states, contrast pass
- [x] Settings screen (JSON-backed): editor command, mergetool
- [x] Import/export = documented config file location + "Open config folder" button
- [x] README: setup, architecture, data location, backup, limitations
- [x] Sponsors note in README + About section in Settings (real links wait for
      the rename, ADR-0010)
- [ ] **Gate:** switch to Krakenless as only Git client for 2 weeks

## Validation checkpoint (after M5)

2 weeks solo dogfood → builds to 3–5 friends → if ≥2 still use it unprompted
after 2 more weeks → proceed to v0.2. Else: keep as personal tool, stop investing.

## v0.2 — only if checkpoint passes

- BYOK AI commit messages (Anthropic/OpenAI/Ollama; optional; `.env.example`)
- Conflict resolution UI (ours/theirs per file → editor later)
- Real product name (trademark-safe), wedge decision, donations push
- Mac/Linux builds if a real user wants them

## Backlog (ideas parking lot — not scheduled)

**Linux CI wedges the runner (open, deprioritised 2026-08-20).** Linux was
pulled out of the CI gate — it is not a v0.1 target and every attempt cost 45
minutes and produced no log. The investigation lives in
`.github/workflows/linux.yml`, runnable on demand, with the groups split so the
step conclusions alone identify the culprit.

Ruled out so far: compilation (`cargo test --no-run` passes in ~75s), machine
resources (`df`/`free` healthy immediately before), the `main.rs` harness that
links WebKitGTK (execution never reaches it), and the frontend suite (passes on
Linux, git integration tests included). The wedge is inside the Rust *lib*
tests, and it is severe enough that the step outlives its own `timeout-minutes`
and an OS-level `timeout --signal=KILL`; the job ends only when the
infrastructure cancels it. The same tests pass on real Linux under WSL in ~1.1s,
though WSL's own service crashed under repeated runs — the same shape of
failure. Prime suspect: `git_runner`'s timeout-and-kill path (`kill_tree` sends
`kill -9 -<pgid>` to a process group). **If that is the cause it is a product
bug on Linux, not just a CI one**, which is why it is written down rather than
silenced with `#[ignore]`.

Found during M3/M4 fan-out (2026-08-20), by the workers and their reviewers:

- ~~`state.remotes` slice~~ — done: `git remote` is the authority, the
  branch-derived list stays as the fallback while the read is pending.
- Force-push-with-lease needs an explicit `<branch>:<oid>` lease plus a
  confirmation dialog before any UI may offer it.
- Push to a differently-named upstream needs a `<local>:<upstream>` refspec;
  until then the remote bar disables that case and prints the command.
- ~~`state.busy` as a depth counter~~ — done: `busyDepth` with an `isBusy()`
  reader, so an overlapping operation cannot re-enable destructive controls.
- No integration test proves the `stash drop` recovery route or that
  `assertStashUnchanged` refuses a shifted list.
- `restoreStash`/`removeStash` return a bare boolean; a discriminated result
  would let the UI stop inferring the cause from prose.
- `formatRelativeDate` is duplicated in `views/history` and `views/refs`.
- A merge whose conflicts are staged but not committed (`MERGE_HEAD` present,
  no unmerged entries) is not gated yet, though `buildOperationProbeCommand`
  already exists to detect it.

Found during M1 fan-out (2026-08-20), by the workers and their reviewers:

- One unparseable commit fails the whole log; consider a per-record
  `unparseable` placeholder so a single poisoned object cannot blind the view.
- `readLog` buffers all history into one string and has no default limit —
  a large repo hits the runner timeout instead of paging.
- No end-to-end integration test drives the real git binary yet; parser
  fixtures are captured by hand. `tests/integration/` is still empty.
- `src/git/diff.ts` and `src/git/log.ts` have no tests of their own (parsers do).
- Status consumers must branch on `entry.conflicted` before `index`/`worktree`;
  `untracked: 'normal'` yields collapsed `dir/` entries a discard must reject.
- `# branch.head (detached)` is ambiguous with a branch named `(detached)`;
  disambiguating needs a `symbolic-ref -q HEAD` cross-check.
- `assertPath` still accepts a leading `:` — decide whether to reject it.
- File history (`git log -- <path>`, `--follow`) is not supported by the builder.
- Conflicted files have no diff view until a conflict-resolution UI exists.

- Interactive rebase UI (drag to reorder/squash)
- Repo tabs
- GitHub/GitLab API integration (PRs, clone lists)
- Submodule / LFS UI
- Graph cache (SQLite) for 100k+ commit repos
- Localization (pt-BR first)
