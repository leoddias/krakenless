# Krakenless

> **Status: pre-alpha — usable for reading and committing, not yet dogfooded.**
> Installers for Windows and macOS (Apple Silicon):
> [v0.1.0-alpha](https://github.com/leoddias/krakenless/releases/tag/v0.1.0-alpha).
> They are unsigned, so both systems will warn before opening them.
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

Rust side (same checks CI runs). Run `npm run build` first — the frontend is
compiled *into* the binary, so every cargo command needs `dist/` to exist:

```sh
npm run build
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
- **``The `frontendDist` configuration is set to `../dist` but this path doesn't
  exist``** — run `npm run build` once. The `custom-protocol` feature is on by
  default (ADR-0024) so that a release binary always carries the interface
  inside it, and that embedding happens while Rust compiles.
- **A built app shows "connection refused" for localhost** — it was compiled
  without `custom-protocol`, so it points at the dev server instead of its own
  files. `npm run tauri build` is the supported way to build; see ADR-0024.

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

## What works today

- Open a repository (folder picker or recent list) and see its history,
  working tree and diffs, refreshed automatically when files change.
- Stage and unstage whole files or individual hunks, write a commit message,
  commit, and amend.
- Discard changes — always by stashing first, so the app can hand you the exact
  command that brings them back.
- Fetch, fast-forward pull, and push (never force), with the branch's real
  relationship to its upstream, or an honest "git did not report it".
- Create, switch and delete branches; list, apply, pop and drop stashes.
- A conflict banner that lists what is conflicted, opens your editor or merge
  tool, and can abort the merge — it does not pretend to resolve conflicts.
- Settings, written to the same JSON file you can edit by hand.

Not there yet: a conflict-resolution UI, interactive rebase, and the commit
graph's parent lines. See [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Keyboard

| Keys | Does |
|---|---|
| `Ctrl+1` … `Ctrl+4` | Focus history, branches, working tree, diff |
| `Ctrl+R` or `F5` | Re-read the repository |
| `Ctrl+Enter` | Commit what is staged (works from inside the message box) |
| `Ctrl+,` | Open settings |
| `Ctrl+W` | Close the repository |

Nothing without a modifier is bound, and no shortcut fires while you are typing
in a field — except `Ctrl+Enter`, which has to work exactly there.

## Safety

The parts of the app that build git commands or parse git output are treated as
the dangerous core:

- Git is spawned with an argument array, never a shell string. Values you can
  name — branches, tags, paths — are validated so a branch called `--force`
  cannot turn into an option.
- Destructive commands are recognized from the arguments themselves, not from a
  flag a builder might forget, and they refuse to run without a confirmation
  minted where the question was actually asked.
- Discard never uses `git restore`; it stashes the selected paths so there is
  always a way back, and the app shows you that command.
- Every parser and command builder ships with unit tests, and the destructive
  paths have integration tests that run the real `git` binary on disposable
  repositories.

## Data location & backup

App settings live in `%APPDATA%/krakenless/` as human-readable JSON — the same
file the Settings screen writes. Backup = copy that folder. Everything else is
your repos, owned by git.

## Releases

Pushing a tag (`v0.1.0-alpha`, say) triggers `.github/workflows/release.yml`,
which runs the full test suite on Windows and macOS, builds the installers, and
attaches them to a **draft** GitHub Release. Draft on purpose: the binaries are
unsigned, so someone has to read the notes and decide they are ready to hand to
people before it goes public.

Note ADR-0010 — the name is a development codename that references someone
else's trademark. Publishing downloadable binaries under it is exactly the step
that ADR says to take only after the rename.

## Updating itself

Krakenless checks once per launch whether a newer release exists, and offers
it; it never installs one on its own. Both shapes of the Windows build are
covered — the installers through `tauri-plugin-updater`, and the portable
executable through code of this project's own, because a loose `.exe` has no
installer to run (ADR-0036).

What the check costs you is one unauthenticated GET of a static JSON file on
`leoddias.github.io`: no account, no identifier, no request body, and no second
request when the file names the version you are already running. The switch is
in Settings, and turning it off means the app makes no such request rather than
hiding the answer.

Nothing is installed without a **minisign signature** made by the release key.
The shipped binaries carry no Authenticode signature, so that is not belt and
braces — it is the only statement that this project built what was
downloaded. The key lives in the release workflow's secrets; see
`docs/CONVENTIONS.md` § Release signing key. First release signed with it:
v0.1.10-alpha, so a copy older than that has to be replaced by hand once.

## Landing page

The site in [`site/`](site/) is plain static HTML with no build step, published
to GitHub Pages by `.github/workflows/pages.yml` whenever `site/**` changes.
Enabling it is a one-time repository setting: **Settings → Pages → Source →
GitHub Actions**.

## Sponsoring

Krakenless is free and will stay free. If it replaces a paid client for you,
sponsoring is the only thing it will ever ask for — links will land here once
the project has its real name (see ADR-0010).

## License

[AGPL-3.0](LICENSE). © Leonardo Dias.
