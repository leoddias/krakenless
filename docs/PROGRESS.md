# Progress — living state

> Updated by every session via the `/handoff` skill. Newest session log first.
> This file is the handover between sessions and agents. Keep *Current state*
> and *Next up* truthful and short; move detail into the session log.

## Current state

- **Phase:** v0.1 feature-complete. Every buildable item in `docs/ROADMAP.md`
  M0–M5 is checked off; the only open item is the dogfood gate, which is two
  weeks of use, not code.
- **Verified in the running app**, by hand with screenshots: welcome + recent
  repos, history with the commit graph and ref decorations, working-tree panel
  (stage/unstage/discard/commit), diff viewer, remote bar, branches + stashes,
  conflict banner, settings, keyboard shortcuts, fs-watch refresh.
- **Test status:** `npm test` 935 passing (40 files, stable across three
  consecutive runs), `cargo test` 36 passing; oxlint, prettier and clippy clean.
- The discard path — the only code that takes work off disk — has integration
  tests that **execute the recovery command the UI displays**. Keep that
  property for any future change to `stage.ts` or `recovery.ts`.
- **Not built:** conflict *resolution* UI, interactive rebase. Both are v0.2.

## Next up (in order)

1. **The dogfood gate** (`docs/ROADMAP.md` § M5): use Krakenless as the only
   Git client for two weeks. Everything else in v0.1 is done, so this is the
   next real step and it produces the list that shapes v0.2.
2. Fix whatever the gate surfaces, in the order it hurts.
3. Then the validation checkpoint in `PLAN.md`: builds to 3–5 friends, and the
   decision to invest in v0.2 or stop.

## Blockers / open questions

- **Linux CI wedges the ubuntu runner** inside the Rust lib tests. Taken out of
  the CI gate on 2026-08-20 (not a v0.1 target); the bisecting workflow is
  `.github/workflows/linux.yml`, run on demand. Full findings and what was ruled
  out are in `docs/ROADMAP.md` § Backlog. Windows and macOS build and test green.

- None blocking. Two deliberate gaps, both documented in code comments:
  force-push is unreachable from the UI until the lease carries an explicit
  `<branch>:<oid>`, and pushing to a differently-named upstream is disabled
  until `buildPushCommand` emits a `<local>:<upstream>` refspec.

## Session log

### 2026-08-20 (later) — v0.1 finished, final safety pass

- Closed M3–M5: conflict banner, settings, About, keyboard shortcuts
  (Ctrl+1..4, Ctrl+R/F5, Ctrl+Enter, Ctrl+`,`, Ctrl+W), commit graph lanes.
- Final `safety-reviewer` pass blocked twice more, both times correctly:
  - `git stash push --include-untracked` stores the file in the stash's *third
    parent*, so the recovery command shipped for an untracked discard could
    never work. Fixed by resolving `^3` to a literal oid (never emitting `^`,
    which cmd.exe eats) and naming only paths the source tree actually holds.
  - The two facts the fix produced — "cannot restore this path", "no command
    for this discard" — were computed and dropped before reaching the screen.
  - `describeStash` walked the whole repository tree, so one undecodable
    filename anywhere made a discard fail *after* moving work off disk.
- Took the backlog items the reviewers filed: `state.remotes` read from
  `git remote` (an unfetched remote was invisible), and `busyDepth` as a
  counter so an overlapping write cannot re-enable destructive controls.
- Running the app found what tests could not: the graph reserved the widest
  lane count on every row and pushed commit subjects off the line.
- Fixed suite flakiness: the three integration files spawn dozens of git
  processes and exceeded Vitest's 5s default under the parallel runner.
- Also corrected a false claim I made to the reviewer — I reported view-layer
  tests that a silently-failed edit had never written. They exist now.
- Tests at handoff: `npm test` 935 passing, `cargo test` 36 passing.

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
