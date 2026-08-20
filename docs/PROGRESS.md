# Progress — living state

> Updated by every session via the `/handoff` skill. Newest session log first.
> This file is the handover between sessions and agents. Keep *Current state*
> and *Next up* truthful and short; move detail into the session log.

## Current state

- **Phase:** pre-code. Planning + harness complete; no application code yet.
- Repo contains: AGPL-3.0 license, `PLAN.md` (agreed product plan),
  agent harness (`CLAUDE.md`, `docs/`, `.claude/` skills + agents).
- Stack locked (see `docs/DECISIONS.md`): Tauri 2 + React/TS, system git via
  shell-out, JSON config, Windows-first.
- Nothing is built or scaffolded. `npm`/`cargo` not yet initialized.

## Next up (in order)

1. **M0 — Scaffold** (`docs/ROADMAP.md` § M0): create the Tauri 2 + React +
   TypeScript + Vite project, ESLint/Prettier, Vitest, CI workflow, `.gitignore`.
2. M1 — read-only repo view (open repo, status, log/graph data).
3. Then follow ROADMAP milestones in order.

## Blockers / open questions

- None. All v0.1 design questions were resolved in the 2026-08-19 interview
  (see `docs/DECISIONS.md`).

## Session log

### 2026-08-19 — Design interview + harness
- Ran full design interview (grill-me). Resolved product identity, stack,
  scope, money model, safety bar, validation checkpoint → `PLAN.md`.
- Discarded the original Python/Typer/SQLite prompt (ADR-0001).
- Created agent harness: `CLAUDE.md`, `docs/` (PROGRESS, ROADMAP, DECISIONS,
  ARCHITECTURE, CONVENTIONS), skills (`handoff`, `adr`, `next-task`),
  `safety-reviewer` agent, README, `.gitignore`.
- No application code written yet.
