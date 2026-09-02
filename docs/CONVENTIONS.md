# Conventions

## Code

- TypeScript strict mode; no `any` in `src/git/**` (the safety core).
- Pure functions for command builders and parsers — no IPC, no globals.
- React: function components, hooks; state lives in `src/state`, views stay thin.
- Rust: plumbing only (see ARCHITECTURE invariants); `clippy` clean.
- English everywhere: identifiers, comments, docs, UI strings.

## Testing (the non-negotiable part — ADR-0008)

- A change to any command builder or parser **includes unit tests in the same
  commit**. No exceptions, including "trivial" changes.
- Integration tests create disposable temp repos and run the real git binary;
  they must pass on a clean Windows machine with only git installed.
- Those repos pin `core.autocrlf=false`, so a test asserts what *this code* does
  to content rather than what git's line-ending conversion did. The
  `autocrlf=true` case — the Git for Windows default — has its own file,
  `src/git/autocrlf.integration.test.ts`, which checks the patch path agrees
  with `git add` byte for byte.
- Run `npm test` before declaring any task done; broken tests block handoff.
- Destructive-operation code paths (discard, force-push, `branch -D`) need an
  integration test proving the recoverable path (e.g. stash created).

## CI

- The gate is `npm run lint`, `npm run format:check`, `npm test`,
  `npm run build`, plus clippy and `cargo test` — run over the **whole repo**,
  not just `src/`. Formatting one directory locally is how a green local run
  turns into a red CI one.
- `.gitattributes` normalises line endings to LF. A file written by a tool that
  defaults to CRLF on Windows would otherwise pass locally and fail
  `prettier --check` in CI.
- The desktop job builds on Windows and macOS. Windows is the shipped target
  for v0.1; macOS keeps the unix code paths (process groups, `reveal_folder`,
  path separators) under a real check. Linux is *not* in the gate — see
  `docs/ROADMAP.md` § Backlog — and runs on demand via `linux.yml`.
- A CI step that can hang needs its own `timeout-minutes` **and** output that
  survives: a cancelled job publishes no log at all, while step conclusions stay
  readable through the API. Splitting a suspect step into named groups turns
  "it hung somewhere" into "it hung here" without needing logs.

## Release signing key

The updater installs nothing it cannot verify (ADR-0036), so the release is
signed with a minisign key that the app carries the public half of.

**This is done.** The key was generated on 2026-09-02, the private half lives
in `~/.krakenless/` on the maintainer's machine (with its password beside it)
and in the repository secrets, and the public half is in the two places listed
below. What follows is the procedure for *rotating* it — which is not a cheap
thing to do, because a new key can only reach users through a build they
install by hand:

1. `npm run tauri signer generate -- -w <path outside this repo>`
2. Store the **private** key somewhere you will still have it in a year.
   Losing it means no already-installed copy of Krakenless can ever be updated
   again — every user would have to download a new build by hand.
3. Add repository secrets `TAURI_SIGNING_PRIVATE_KEY` (the file's contents) and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty is fine if the key has none;
   the secret must exist either way).
4. Put the **public** key in two places, which a unit test asserts are equal:
   `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`, and
   `UPDATE_PUBLIC_KEY` in `src-tauri/src/updater.rs`.

The private key never touches this repository or a log. `updater.rs` also
carries a fixture signed by the real key, so a truncated or mistyped public key
fails the suite rather than shipping a release nobody can install. The release workflow refuses to build without it rather than shipping
binaries no installed copy will accept.

## Commits

- Conventional Commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`,
  `chore:`, `ci:`. Scope optional: `feat(staging): ...`
- Subject line only — no body, no `Co-Authored-By` or other trailers.
  Use the `/commit` skill.
- Small, coherent commits; a milestone checkbox ≈ 1–3 commits.
- Check off the matching `docs/ROADMAP.md` item in the same commit that
  completes it.

## Vibe-coding rules (for agents)

- Read `docs/PROGRESS.md` before writing code; update it after (see `/handoff`).
- Don't invent scope: anything not in the current milestone goes to
  ROADMAP § Backlog.
- Generated code gets the same test bar as handwritten code. If you can't
  test it, don't ship it.
- After touching `src/git/**` or `src-tauri/src/git_runner.rs`, run the
  `safety-reviewer` agent before handoff.
- Never commit `.env`, keys, or user repo paths in fixtures.
