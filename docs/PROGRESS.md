# Progress — living state

> Updated by every session via the `/handoff` skill. Newest session log first.
> This file is the handover between sessions and agents. Keep *Current state*
> and *Next up* truthful and short; move detail into the session log.

## Current state

- **Phase:** M0–M4 complete; M5 mostly done. The app runs and was driven by hand
  (screenshots) against this repository, not only through tests.
- **Verified working in the real app:** welcome + recent repos, history with ref
  decorations, working-tree panel (stage/unstage/discard/commit), diff panel,
  remote bar (fetch/pull/push), branches + stashes panel, conflict banner,
  settings, fs-watch refresh.
- **Test status:** `npm test` 881 passing (35 files), `cargo test` 32 passing;
  oxlint, prettier and clippy clean. Integration tests drive the real `git`
  binary on disposable repos for patch round-trips and destructive paths.
- Settings live in `%APPDATA%/krakenless/config.json` — the path the docs
  promise (Tauri's default would have been `dev.krakenless.app`).
- **Not built:** conflict *resolution* UI, graph parent lines, interactive
  rebase. `state.remotes` is reconstructed from branches, not read directly.

## Next up (in order)

1. **Close M5** (`docs/ROADMAP.md` § M5): keyboard navigation and focus pass
   across the four panels, contrast check, then the dogfood gate — use
   Krakenless as the only Git client for two weeks.
2. **Graph parent lines** (M4's last item): commit edges between rows in
   `src/views/history`. Functional, not beautiful.
3. Work the backlog the reviewers filed, highest value first: a real
   `state.remotes` slice (unfetched remotes are invisible today), `busy` as a
   depth counter rather than a boolean, and an integration test for the
   stash-drop recovery route.

## Blockers / open questions

- None blocking. Two deliberate gaps, both documented in code comments:
  force-push is unreachable from the UI until the lease carries an explicit
  `<branch>:<oid>`, and pushing to a differently-named upstream is disabled
  until `buildPushCommand` emits a `<local>:<upstream>` refspec.

## Session log

### 2026-08-20 — M1–M4 built with parallel packets and capped loops

- Ran six task packets through `/fanout` (status/log/diff parsers; welcome,
  history and diff views; changes panel; remote bar; refs panel), each in its
  own worktree with `conventions-reviewer` and, where it touched git, the
  `safety-reviewer`. Every packet needed 2–3 loop passes before its gate passed.
- Built: the git layer contract, staging (including hunk-level via
  `git apply --cached`), remotes, branches, stashes, the fs watcher, config,
  store and actions, the app shell, settings, and the conflict banner.
- ADRs added: 0013 (capped loops + parallel packets), 0014 (oxlint), 0015 (path
  encoding decided at the runner), 0016 (destructiveness derived from args).
- The safety reviewer blocked three times and was right each time. Fixed, each
  with a test: the log record separator let a commit message forge a whole fake
  commit; discard destroyed the *staged* snapshot while advertising a
  `stash pop` that could not restore it; the replacement undo command
  (`git checkout <oid> --`) clobbered that same snapshot; force-push
  self-approved through a module-level `CONFIRMED` constant; stash operations
  addressed entries by a shifting index; the Rust runner reported a truncated
  read as an empty success.
- Running the app by hand found three things no test caught: settings were
  written to `dev.krakenless.app` rather than the documented folder, the diff
  panel opened empty, and history rows cut oids mid-hash.
- Also fixed a test-harness bug: `beforeEach(() => mock.mockReset())` returns
  the mock, and Vitest calls a returned function as teardown — so mocks were
  being invoked after every test. Six occurrences.
- Tests at handoff: `npm test` 881 passing, `cargo test` 32 passing.

### 2026-08-19 — Parallel harness + M0 scaffold (complete)

- Installed the Rust toolchain locally (rustup via winget; MSVC C++ tools were
  already present from VS 2022). `cargo build`, `cargo clippy -D warnings` and
  `cargo test` all pass; `npm run tauri dev` opens the window — M0 closed.
- README gained a full contributor setup section: prerequisite table, winget
  commands, non-Windows notes, the pre-PR gate, and troubleshooting.

- Added the parallel-work harness: `docs/PARALLEL.md` (task packets with
  disjoint owned globs, worktree isolation, orchestrator-only integration),
  `docs/TASKS.md` board, `/fanout` and `/task-loop` skills, `task-worker` and
  `conventions-reviewer` agents. Locked as ADR-0013; wired into `CLAUDE.md`.
- Scaffolded the app (M0): Vite react-ts template into the repo, strict
  tsconfig, Vitest + jsdom + Testing Library with a passing App test, Prettier
  (markdown excluded so agent docs stay stable), oxlint (ADR-0014), Tauri 2
  init with renamed crate/identifier/window size, CI workflow.
- Verified locally: `npm test` green, `npm run build` green, `npm run lint`
  clean, `npm run format:check` clean. **Not** verified: anything Rust.
- Scaffolding was deliberately kept single-agent — per PARALLEL.md, fan-out
  needs ≥2 disjoint packets and a settled contract; M0 had neither.

### 2026-08-19 — Design interview + harness
- Ran full design interview (grill-me). Resolved product identity, stack,
  scope, money model, safety bar, validation checkpoint → `PLAN.md`.
- Discarded the original Python/Typer/SQLite prompt (ADR-0001).
- Created agent harness: `CLAUDE.md`, `docs/` (PROGRESS, ROADMAP, DECISIONS,
  ARCHITECTURE, CONVENTIONS), skills (`handoff`, `adr`, `next-task`),
  `safety-reviewer` agent, README, `.gitignore`.
- No application code written yet.
