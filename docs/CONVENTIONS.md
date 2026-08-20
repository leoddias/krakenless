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
- The desktop job builds on Windows, macOS and Linux. Windows is the only
  shipped target for v0.1; the other two exist because the git layer has
  platform-specific code (process groups, `reveal_folder`, path separators) and
  a break there is a real bug even where we do not ship.

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
