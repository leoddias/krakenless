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
- [ ] Welcome screen: recent repos (JSON config in `%APPDATA%/krakenless`) + folder picker
- [x] Parse `git status --porcelain=v2 --branch` → typed model (unit tests)
- [x] Parse `git log` with explicit `--format` separator → commit list (unit tests)
- [ ] Commit list UI (virtualized) with branch/tag/HEAD decorations
- [ ] Diff viewer: `git diff` / `git show` parsed (done) and rendered read-only (UI pending)
- [ ] Loading / empty / error states for every panel

### M2 — Staging + commit (~1–2 weeks; hardest milestone)
- [ ] Stage/unstage whole files (`git add` / `git restore --staged`) (integration tests)
- [ ] Hunk model: parse unified diff into hunks (unit tests)
- [ ] Stage/unstage hunk via `git apply --cached [-R]` round-trip (integration tests on temp repos)
- [ ] Commit message editor + commit + amend
- [ ] Discard changes — confirm dialog, recoverable form (stash-before-discard) (integration tests)
- [ ] Working tree auto-refresh (fs watcher, debounced)

### M3 — Remotes (~1 week)
- [ ] Fetch / pull / push with progress and readable error surfaces
- [ ] Ahead/behind indicators
- [ ] Conflict detection → honest banner: conflicted files list, "Open in editor",
      "Open git mergetool", "Abort merge" (integration tests for state detection)

### M4 — Branches + stash (~1 week)
- [ ] Create / checkout / delete branch (delete = confirm; prefer `-d`, explicit `-D`)
- [ ] Stash push / pop / list
- [ ] Graph edges between commits (parent lines) — functional, not beautiful

### M5 — Polish + dogfood gate (~1 week)
- [ ] Keyboard navigation, focus states, contrast pass
- [ ] Settings screen (JSON-backed): editor command, mergetool
- [ ] Import/export = documented config file location + "Open config folder" button
- [ ] README: setup, architecture, data location, backup, limitations
- [ ] Sponsors/Ko-fi link in README + About dialog
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
