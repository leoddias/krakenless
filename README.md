# Krakenless

> **Status: pre-alpha — scaffold only. Not usable as a Git client yet.**
> "Krakenless" is a development codename; the project will be renamed before
> any public release.

A fast, private desktop Git GUI:

- **No account.** Open the app, open a repo, work.
- **No telemetry, no analytics, ever.** Your repos never leave your machine.
- **No subscription.** Free and open source (AGPL-3.0); donations welcome.
- **Small and fast.** Tauri 2 shell (~10 MB class), not a bundled browser.
- Uses **your own `git`** underneath — your credentials, hooks, and LFS
  setup work because it *is* git.

Optional AI features (commit message generation) are planned for later,
bring-your-own-key only — the app stays 100% functional without any key.

## Setup (contributors)

The frontend runs anywhere; the desktop shell needs a Windows C/C++ toolchain
because Tauri compiles a native binary. Install in this order.

### 1. Prerequisites

| Dependency | Version | Why |
|---|---|---|
| [Git](https://git-scm.com/download/win) | 2.39+ | the app *is* a git client — it shells out to your `git` |
| [Node.js](https://nodejs.org) | 22 LTS+ | frontend, tests, Tauri CLI |
| [Rust](https://rustup.rs) (stable) | 1.90+ | compiles the Tauri shell |
| MSVC C++ build tools | VS 2022+ | linker for the Rust build |
| WebView2 runtime | any | the window's renderer — preinstalled on Windows 11 |

On Windows, everything except the C++ workload can come from winget:

```powershell
winget install Git.Git
winget install OpenJS.NodeJS.LTS
winget install Rustlang.Rustup
```

For the C++ toolchain, install **Visual Studio Build Tools** and tick the
*"Desktop development with C++"* workload (if you already have Visual Studio
with that workload, you're done):

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools
```

Then open a **new** terminal so `cargo` and `node` are on PATH, and verify:

```powershell
git --version; node --version; cargo --version
```

macOS/Linux: install git, Node 22+, and rustup from your package manager, plus
the platform's Tauri system dependencies (`build-essential`, `libwebkit2gtk-4.1-dev`,
`libssl-dev`, `librsvg2-dev` on Debian/Ubuntu; Xcode command line tools on macOS).
Only Windows is targeted for v0.1, so non-Windows builds are untested.

### 2. Project

```sh
git clone <repo-url>
cd krakenless
npm install
```

First `npm run tauri dev` compiles ~500 Rust crates and takes a few minutes;
later runs are incremental.

## Development

```sh
npm run tauri dev    # run the desktop app (needs Rust)
npm run dev          # run the frontend alone in a browser
npm test             # run the test suite (Vitest)
npm run lint         # oxlint
npm run format       # Prettier (code only; markdown is left alone)
npm run build        # type-check + build the frontend
npm run tauri build  # build the Windows desktop binary (needs Rust)
```

Rust side (same checks CI runs):

```sh
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Before opening a PR, the whole gate must be green: `npm run lint`,
`npm run format:check`, `npm test`, `npm run build`, plus the two cargo
commands if you touched `src-tauri/`. Code that builds git commands or parses
git output ships with unit tests in the same change — see
[`docs/CONVENTIONS.md`](docs/CONVENTIONS.md).

### Troubleshooting

- **`cargo: command not found`** — reopen the terminal after installing
  rustup, or add `%USERPROFILE%\.cargoin` to PATH.
- **`link.exe not found` / linker errors** — the C++ workload is missing;
  install Visual Studio Build Tools with *Desktop development with C++*.
- **Port 1420 in use** — a previous `tauri dev` is still running; the dev
  server uses a strict port and will refuse to start.

## Documentation

- [`PLAN.md`](PLAN.md) — product vision and agreed scope
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — milestones toward v0.1
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how it's built
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — why it's built this way
- [`CLAUDE.md`](CLAUDE.md) + [`docs/PROGRESS.md`](docs/PROGRESS.md) — the
  agent harness: this project is developed with AI agents, and these files
  carry context between sessions

## Planned requirements (v0.1)

- Windows 10/11 (Mac/Linux later)
- `git` installed and on PATH

## Data location & backup

App settings live in `%APPDATA%/krakenless/` as human-readable JSON.
Backup = copy that folder. Everything else is your repos, owned by git.

## License

[AGPL-3.0](LICENSE). © Leonardo Dias.
