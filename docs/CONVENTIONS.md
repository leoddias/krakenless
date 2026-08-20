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
