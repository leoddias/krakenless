# Krakenless — Agent Harness

Fast, private desktop Git GUI (anti-GitKraken: no account, no telemetry, no
subscription). Tauri 2 + React/TS, shelling out to system `git`. AGPL-3.0.
This file is the entry point for every session — human or agent.

## Session protocol (mandatory)

1. **Start:** read `docs/PROGRESS.md` (sections *Current state* and *Next up*).
   That is the single source of truth for where work stands. Do not re-derive
   state from git history if PROGRESS.md answers it.
2. **Before architectural choices:** check `docs/DECISIONS.md`. Locked
   decisions are not renegotiated casually — changing one requires a new ADR
   entry superseding the old (use the `/adr` skill).
3. **During work:** follow `docs/CONVENTIONS.md` (style, tests, commits). Every
   non-trivial task runs through `/task-loop`; work is *done* only when the
   suite is green and review findings are resolved, never when the code is
   merely written. Parallel work follows `docs/PARALLEL.md` (`/fanout`).
4. **End of session / task done:** run the `/handoff` skill — update
   `docs/PROGRESS.md` (Current state, Next up, Session log). A session that
   doesn't update PROGRESS.md loses its context forever.

## Document map

| File | Role | Mutability |
|---|---|---|
| `PLAN.md` | Product vision & shared understanding from the design interview | Stable; change only via ADR |
| `docs/PROGRESS.md` | Living state: what's done, in flight, next; session log | Every session |
| `docs/ROADMAP.md` | Milestones M0–M5 for v0.1 with task checklists | Check off as done; reshape via ADR |
| `docs/DECISIONS.md` | ADR log — every locked decision and its why | Append-only (supersede, don't edit) |
| `docs/ARCHITECTURE.md` | Module layout, data flow, git-layer design | Update when structure changes |
| `docs/CONVENTIONS.md` | Code style, testing bar, commit format | Update via ADR |
| `docs/PARALLEL.md` | How agents work in parallel and how a task is looped to done | Update via ADR |
| `docs/TASKS.md` | Scratch board of in-flight task packets | Cleared after each fan-out |

## Non-negotiable rules

- **Safety bar ("paranoid core"):** any code that *builds* a git command or
  *parses* git output ships with unit tests in the same change. Destructive
  operations (discard, force-push, `branch -D`) always confirm in UI and
  prefer recoverable forms. See `docs/CONVENTIONS.md`.
- **Privacy:** no analytics, no telemetry, no network calls except git
  remotes (and BYOK AI in v0.2+). Never log secrets or private file contents.
- **Scope discipline:** v0.1 scope is fixed in `PLAN.md`. Feature ideas go to
  `docs/ROADMAP.md` § Backlog, not into the sprint.
- **Changes that alter behavior get committed with tests passing.** Run the
  test suite before declaring anything done.
- Language: code, docs, and UI in **English**. Conversation with the user may
  be in Portuguese.

## Skills & agents available here

- `/commit` — commit in project style: single-line subject, no body, no trailers
- `/handoff` — write the end-of-session state into PROGRESS.md
- `/adr` — record or supersede a decision in DECISIONS.md
- `/next-task` — pick up the next unblocked task from ROADMAP/PROGRESS
- `/task-loop` — drive one task to done: build → test → review → fix, capped at
  3 passes, gate = green suite + no critical/major findings
- `/fanout` — split a milestone into disjoint packets and run one `task-worker`
  per packet in its own worktree, then integrate
- Agent `task-worker` — executes a single packet's loop in isolation
- Agent `conventions-reviewer` — read-only review against CONVENTIONS + the
  packet's definition of done
- Agent `safety-reviewer` — reviews git command builders/parsers for
  repo-destroying bugs; use after changing the git layer
