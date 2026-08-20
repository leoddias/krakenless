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

## Development

Requirements: Node 22+, Rust (stable, via [rustup](https://rustup.rs)), and
`git` on PATH. Rust is only needed for the desktop shell — the web frontend
and its tests run without it.

```sh
npm install          # install frontend dependencies
npm run tauri dev    # run the desktop app (needs Rust)
npm run dev          # run the frontend alone in a browser
npm test             # run the test suite (Vitest)
npm run lint         # oxlint
npm run format       # Prettier (code only; markdown is left alone)
npm run build        # type-check + build the frontend
npm run tauri build  # build the Windows desktop binary (needs Rust)
```

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
