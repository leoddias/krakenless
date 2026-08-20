# Architecture

> Status: **planned** — no code exists yet. Update this file as the real
> structure lands (M0+). Diverging from this doc without an ADR is a bug.

## Big picture

```
┌────────────────────────────────────────────────┐
│ Tauri 2 window (WebView2 on Windows)           │
│                                                │
│  React + TypeScript UI (Vite)                  │
│   ├─ views: Welcome · Repo (graph/status/diff) │
│   ├─ state: one open repo at a time            │
│   └─ invokes Tauri commands (IPC)              │
├────────────────────────────────────────────────┤
│ Rust shell (thin — no git logic)               │
│   ├─ run_git(repo, args[]) → {out, err, code}  │
│   ├─ fs watcher (debounced events to UI)       │
│   ├─ config read/write (%APPDATA%/krakenless)  │
│   └─ open editor / mergetool / config folder   │
├────────────────────────────────────────────────┤
│ system `git` binary (user-installed)           │
│   credentials: GCM / ssh-agent (not ours)      │
└────────────────────────────────────────────────┘
```

## Where logic lives

- **All git intelligence is TypeScript**: command *builders* (produce args
  arrays) and output *parsers* (porcelain v2, `--format` with explicit
  separators, unified diff → hunks). Pure functions, no IPC — this is what
  makes them trivially unit-testable and is the safety-critical core (ADR-0008).
- **Rust is plumbing only**: spawn git, stream output, watch fs, touch disk.
  If a Rust function contains git semantics, it's in the wrong layer.

## Planned layout

```
src/                    # React + TS
  git/
    commands/           # builders: pure fns → GitCommand { args: string[] }
    parsers/            # porcelain/log/diff parsers + unit tests
    runner.ts           # invoke('run_git'), timeouts, error typing
  views/                # Welcome, Repo (Graph, Status, DiffViewer, ...)
  state/                # open-repo store, refresh orchestration
  config/               # typed settings schema + load/save via IPC
src-tauri/              # Rust shell
  src/
    git_runner.rs       # spawn git, no shell, args array, capture, timeout
    watcher.rs
    config.rs
tests/
  integration/          # real git against disposable temp repos
docs/                   # this harness
```

## Invariants (safety)

1. Git is always spawned with an **args array — never a shell string**;
   paths are passed after `--` where git supports it.
2. Parsers use machine-stable formats only (`--porcelain=v2`, `-z`,
   explicit `--format` separators). Never parse human-oriented output.
3. Destructive commands are built by dedicated builders that require an
   explicit `confirmed: true` marker from the UI layer.
4. The app never writes inside `.git/` directly; git does.
5. No network calls originate from the app itself (git does its own).

## Data locations

- App config: `%APPDATA%/krakenless/config.json` (human-readable, backup = copy)
- Logs (if any): same folder, never containing file contents or secrets
- Everything else lives in the user's repos, owned by git
