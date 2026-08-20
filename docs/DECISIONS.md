# Decision log (ADRs)

Append-only. To change a decision, add a new entry that supersedes the old
one (use the `/adr` skill). Format: number, date, status, decision, why,
consequences.

---

## ADR-0001 — Discard the Python/Typer/SQLite prompt
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** The original prompt (AI CLI: index repo → call model → propose
diffs) is not the product. Only its hygiene rules survive (local-first, no
telemetry, .env discipline, tests, import/export, honest UI states).
**Why:** It described an AI coding assistant competing with Aider/Claude Code
while explicitly excluding frontier model quality — unwinnable. The stated
goal ("replace GitKraken") requires a GUI.
**Consequences:** No Typer, no SQLite, no Python runtime in the product.

## ADR-0002 — Product identity: Git GUI; AI is an optional extra
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** Krakenless is a fast, private desktop Git GUI. AI features are
strictly optional, BYOK, from v0.2.
**Why:** GitKraken's real weaknesses are account requirement, subscription,
bloat, telemetry — not lack of AI. Never compete on model quality.

## ADR-0003 — Stack: Tauri 2 + React + TypeScript (Vite)
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** Tauri 2 shell (thin Rust), React+TS frontend.
**Why:** Small fast binary embodies the anti-bloat pitch; web frontend has the
best ecosystem for virtualized lists/diff viewers and the best AI-codegen
support for a vibecoded project. Flutter/Electron/PySide rejected (FFI cost /
bloat contradiction / packaging pain respectively).

## ADR-0004 — Git backend: shell out to system `git`
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** Execute the user's `git` binary with args arrays; parse
porcelain/`--format` output. No libgit2.
**Why:** Behavior-correct by definition; credentials (GCM/ssh-agent), hooks,
LFS work because it IS git. Users are developers; git being installed is fine.
**Consequences:** Parsers and command builders are the safety-critical core →
ADR-0008.

## ADR-0005 — App data: plain JSON in `%APPDATA%/krakenless`
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** Settings, recent repos, window state in human-readable JSON.
No database. Import/export = file copy.
**Why:** Git is the database for repo data; SQLite solved a problem this app
doesn't have. Revisit only as an optional graph cache for huge repos.

## ADR-0006 — Windows-first; cross-platform-capable stack
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** v0.1 builds and is tested on Windows only. Mac/Linux deferred
until a real user wants a build (Mac signing costs $99/yr — post-validation).

## ADR-0007 — v0.1 scope: core loop + hunk staging; conflicts = honest banner
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** In: open repo, graph, file+hunk staging, commit/amend,
push/pull/fetch, branches, stash, honest conflict banner with editor/mergetool
handoff. Out: conflict editor, interactive rebase, tabs, forge APIs, AI.
**Why:** Smallest thing that can replace GitKraken daily; hunk staging is half
the reason people open a Git GUI. Conflict editor would double time-to-dogfood.

## ADR-0008 — Testing bar: paranoid core, light UI
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** Every git-output parser and command builder is unit-tested
(Vitest); integration suite runs real git against disposable temp repos
covering the full loop incl. hunk staging. Destructive ops confirm in UI and
prefer recoverable forms. No window-driving e2e in v0.1.
**Why:** The app mutates repositories; a misparsed path in a `checkout --`
destroys work. Vibecoded discipline lives in the test suite.

## ADR-0009 — Money: donations only (phase 1); AGPL-3.0
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** Public repo + Sponsors/Ko-fi from day 1. Paid builds / open-core
reconsidered only after the validation checkpoint passes.

## ADR-0010 — "Krakenless" is a dev codename only
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** Rename before any public launch + donations push. The name
references Axosoft's GitKraken trademark; asking for money while invoking a
competitor's mark is the scenario that triggers cease-and-desists.

## ADR-0011 — Auth: inherit system git credentials
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** No credential storage in the app. HTTPS via Git Credential
Manager, SSH via user's agent — free consequence of ADR-0004. No forge OAuth
in v0.1.

## ADR-0012 — Validation checkpoint gates further investment
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** 2 weeks solo dogfood (GitKraken closed) → builds to 3–5 friends
→ ≥2 friends still using after 2 more weeks ⇒ invest in v0.2 + real name +
wedge. Otherwise stop investing; keep as personal tool.

## ADR-0013 — Work is executed as capped loops, parallelized by worktree packets
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** Every non-trivial task runs the loop build → test → review → fix
with a hard gate (green suite + no unresolved critical/major findings) and a
cap of 3 passes before it must escalate as blocked. Parallel work is done by
splitting a milestone into task packets with *disjoint owned file globs*, one
`task-worker` agent per packet in its own git worktree, integrated one at a
time by the orchestrator. Protocol: `docs/PARALLEL.md`.
**Why:** Agent-written code is cheap to produce and expensive to trust; the
bottleneck is verification, so verification is built into the unit of work
rather than left to a later pass. Worktree isolation with exclusive file
ownership is what makes concurrency safe without runtime coordination — the
alternative (several agents editing one tree) trades review time for merge
archaeology. The iteration cap exists because a loop that can't converge in 3
passes signals a mis-specified task, not insufficient effort.
**Consequences:** Splitting cost is paid up front (contracts committed before
fan-out); shared files are orchestrator-only, so workers *request* those edits.
Max 4 concurrent packets. Sequential single-agent work remains the default.

## ADR-0014 — oxlint instead of ESLint
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** Lint with oxlint (the Vite react-ts template's default); format
with Prettier, configured to leave markdown alone so docs stay stable across
agent sessions. Supersedes the "ESLint + Prettier" wording in ROADMAP M0.
**Why:** oxlint is what the current template ships, needs no plugin stack for
React/TS rules, and runs fast enough to sit in every task loop's gate. ESLint's
extra configuration surface buys nothing this project needs.
**Consequences:** Rules live in `.oxlintrc.json`. If a rule we need turns out to
be ESLint-only, add ESLint alongside rather than switching back.

## ADR-0015 — Path encoding and git invocation defaults are decided at the runner
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** Every git invocation is prefixed by the Rust runner with
`--no-pager -c core.quotePath=false`, runs with a scrubbed `GIT_*` environment,
and reports whether stdout decoded as valid UTF-8. Output that decoded lossily
is refused by the TypeScript runner unless the caller explicitly opts in, and
never for output that will be parsed into paths.
**Why:** Path quoting, paging and environment inheritance are properties of
*how git is called*, not of any single command; deciding them per builder means
the first author who forgets produces a parser that silently mangles non-ASCII
paths. Inherited `GIT_INDEX_FILE`/`GIT_DIR`-style variables can redirect writes
to a foreign index — launching the app from inside a rebase hook would be enough.
A lossy path fed back into a write command is the exact "misparse becomes data
loss" case the safety bar exists to prevent.
**Consequences:** Parsers may assume unquoted UTF-8 paths. Builders must not
re-specify these globals. Binary-ish output (e.g. `show` of a binary blob) needs
`allowLossyOutput` at the call site.

## ADR-0016 — Destructiveness is derived from the arguments, not declared
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** `runGit` refuses to execute an unconfirmed command when either the
builder marked it destructive *or* `isDestructive(args)` recognizes it from the
argument array (`reset --hard`, `checkout/restore`, `clean`, `branch -D`,
`push --force`/`+refspec`, `stash drop|clear|pop`, `rebase`, `gc`, ...).
Supersedes the flag-only gate described in ADR-0008's original wording.
**Why:** A gate that depends on every future builder remembering a boolean fails
the first time someone forgets one — and the failure mode is an unconfirmed
`reset --hard`. Deriving it from the args makes the check mechanical at a single
chokepoint. The list is deliberately over-inclusive: a false positive costs one
confirmation dialog, a false negative costs the user's work.
**Consequences:** Read-only commands that happen to match must pass
`confirmed: true` explicitly, which is intentional friction.
