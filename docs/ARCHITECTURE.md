# Architecture

> Status: **in progress** — M0–M2 are done; M3/M4 exist in the git layer with
> their views in flight. The layout below marks what has landed. Diverging from
> this doc without an ADR is a bug.

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
    types.ts            # [done] shared contract: GitCommand, RepoStatus, Commit, FileDiff...
    errors.ts           # [done] GitError + stderr classification
    runner.ts           # [done] invoke('git_run'), timeouts, destructive gate
    argsafety.ts        # [done] pathspec()/assertRefName()/assertRevision() guards
    destructive.ts      # [done] isDestructive(args) — the gate, derived from args
    confirm.ts          # [done] Confirmation token, minted only where the user answered
    patch.ts            # [done] hunks → patch for `git apply --cached`
    repository.ts       # [done] open/identify a repository
    status.ts log.ts diff.ts stage.ts refs.ts   # [done] thin async layers
    commands/           # [done] builders: pure fns → GitCommand { args: string[] }
    parsers/            # [done] porcelain/log/diff/branch parsers + unit tests
  views/                # [done] welcome, history, diff, changes, settings, shell
                        #   (remote + refs panels in flight)
  state/                # [done] store, actions, fs-watch bridge
  config/               # [done] typed settings schema + load/save via IPC
src-tauri/              # Rust shell
  src/
    git_runner.rs       # [done] spawn git, no shell, args array, capture, timeout
    watcher.rs          # [done] debounced fs events, git-noise filtered
    config.rs           # [done] atomic JSON read/write in %APPDATA%
src/git/*.integration.test.ts   # [done] real git against disposable temp repos
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
