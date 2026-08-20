# Progress — living state

> Updated by every session via the `/handoff` skill. Newest session log first.
> This file is the handover between sessions and agents. Keep *Current state*
> and *Next up* truthful and short; move detail into the session log.

## Current state

- **Phase:** M0 scaffold landed. App code exists; the desktop shell is unverified.
- Frontend: Vite + React 19 + TS (strict, `noUncheckedIndexedAccess`), Vitest +
  Testing Library (1 test, green), oxlint, Prettier (markdown excluded).
- Desktop: `src-tauri/` initialized (crate `krakenless`, identifier
  `dev.krakenless.app`, 1280x800 window). **Never compiled** — no Rust locally.
- CI: `.github/workflows/ci.yml` — frontend lint/format/test/build job +
  Windows job (clippy, cargo test, `tauri build`).
- Agent harness now covers parallel work: `docs/PARALLEL.md`, `docs/TASKS.md`,
  `/fanout`, `/task-loop`, agents `task-worker` + `conventions-reviewer`
  (ADR-0013). Linter choice recorded in ADR-0014.

## Blockers / open questions

- **Rust toolchain missing on the dev machine** (`cargo`/`rustc` not on PATH).
  Blocks: running or building the desktop app, `cargo test`, clippy. Fix:
  install rustup + MSVC build tools. Nothing in the frontend is blocked.
- Everything Tauri-side (`src-tauri/`) is therefore unverified code — treat the
  first successful `tauri dev` as the real M0 completion.

## Session log

### 2026-08-19 — Parallel harness + M0 scaffold

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
