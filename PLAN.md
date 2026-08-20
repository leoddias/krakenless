# Krakenless — Shared Understanding (2026-08-19)

Product plan agreed after design interview. This document is the blueprint;
the original Python/Typer/SQLite prompt is **discarded** (it described a
different product — an AI coding CLI). Only its hygiene rules survive.

## What Krakenless is

A **fast, private, desktop Git GUI** — the anti-GitKraken: no account, no
telemetry, no subscription, small binary, repos never leave the machine.
AI is a strictly optional extra (v0.2+, bring-your-own-key), never the
identity, so we never compete on model quality.

- **License:** AGPL-3.0 (already in repo).
- **Money model (phase 1):** donations only (GitHub Sponsors / Ko-fi link in
  README + About dialog). Revisit open-core / paid builds only after the
  validation checkpoint passes.
- **Wedge/customer:** deliberately undecided until friends validate. Working
  hypothesis to test later: privacy + pay-once developers.
- **Name:** "Krakenless" is the dev codename only. It references the
  GitKraken trademark; before any public launch + donations push, pick a
  standalone name and check domain/trademark. One evening, later.

## Stack (locked)

| Layer | Choice | Why |
|---|---|---|
| Shell | Tauri 2 (Rust, thin) | ~10 MB binary, fast startup — the anti-bloat story is in the binary |
| UI | React + TypeScript (Vite) | Best ecosystem for virtualized lists/diff viewers; best AI-codegen support for a vibecoded project |
| Git | Shell out to system `git` (porcelain formats) | Behavior-correct by definition; SSH/credentials/hooks/LFS work because it IS git. Requires git installed — fine, users are devs |
| Auth | Inherited from system git (GCM / ssh-agent) | App stores zero credentials in v0.1 |
| App data | Plain JSON in `%APPDATA%/krakenless` | Settings, recent repos, window state. Human-readable; import/export = file copy. No SQLite |
| Platform | Windows first | Dogfooding happens on Windows 11; stack stays cross-platform-capable; Mac/Linux packaging deferred until someone real wants it |

## v0.1 — dogfood build (target: 4–6 weeks at ~5–10 h/wk)

**In scope (the core loop):**
- Welcome screen: recent repos list + folder picker (one repo open at a time)
- Commit graph (virtualized; branches, tags, HEAD)
- Working-tree status; stage/unstage at **file and hunk** level; diff viewer
- Commit (message editor), amend
- Push / pull / fetch with progress and clear error surfaces
- Branch: create / checkout / delete; stash push/pop
- Conflict handling = **honest banner**: list conflicted files, buttons for
  "Open in editor", "Open configured git mergetool", "Abort merge". Never
  block, never lie about state. No built-in resolver in v0.1
- Empty / loading / error / success states everywhere; keyboard navigation,
  labels, focus states, sensible contrast

**Explicitly out of v0.1:** conflict editor, interactive rebase, repo tabs,
GitHub/GitLab API integration, submodule UI, LFS UI, any AI, Mac/Linux
builds, localization (English only).

## v0.2 (only if checkpoint passes)

- BYOK AI commit messages from staged diff (Anthropic/OpenAI/Ollama; key in
  local config, never required, app fully functional without it)
- Conflict resolution UI (pick ours/theirs, then full editor later)
- Real name + wedge decision + donations push

## Safety & testing bar ("paranoid core, light UI")

The app mutates people's repositories; the risk isn't UI bugs, it's a wrong
or misparsed git command destroying work.

- Every git-output **parser** and every **command builder** unit-tested (Vitest)
- Integration suite runs **real git against disposable temp repos** covering
  the full loop including hunk staging (apply --cached round-trips)
- Destructive operations (discard, force-push, `branch -D`) always confirm
  in UI and prefer recoverable forms (e.g. stash before discard where sane)
- No e2e window-driving tests in v0.1
- Never log secrets or private file contents; no analytics/telemetry ever

## Repo & process

- GitHub repo **public from day 1**, Sponsors/Ko-fi button from day 1
- CI: GitHub Actions — lint, unit + integration tests, Windows build
- Hygiene kept from the old prompt: local-first, `.env.example` if/when any
  key exists (v0.2+), realistic clearly-labelled sample data only in tests,
  README with setup/architecture/data location/backup/limitations

## Validation checkpoint (the reality check)

1. Build v0.1 → use it as **your only Git client for 2 weeks** (GitKraken
   stays closed).
2. If that holds: give builds to **3–5 friends**.
3. If **≥2 friends still use it unprompted after 2 more weeks** → invest in
   v0.2, pick the real name, decide the wedge and money model upgrade.
4. If not → keep it as a personal tool and stop investing. That outcome is
   also a win.

## Known risks (accepted)

- Trademark exposure of the codename (mitigated: rename before launch)
- Donations ≈ €0 until the product is genuinely loved — expected
- Hunk staging and graph rendering are the two hardest v0.1 items; if the
  schedule slips, cut *graph polish*, never *parser tests*
- Solo + vibecoded: discipline lives in the test suite, not in review
