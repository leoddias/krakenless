---
name: task-loop
description: Drive one task to actually-done — implement, test, review, fix — with an iteration cap and a hard gate. Use for any non-trivial single task, and inside every /fanout packet.
---

# Task loop — done means green

Writing the code is a third of the task. This skill is the other two thirds.
Full protocol: `docs/PARALLEL.md` § The loop.

## Steps

1. **Define done first.** One paragraph: the observable outcome, plus the
   named tests that must exist and pass. Write it before touching code — if
   you can't state it, the task isn't specified yet, so ask.
2. **Build** the smallest complete slice.
3. **Test.** Run `npm test` (plus `cargo test` when Rust changed). Command
   builders and parsers ship unit tests in the same change (ADR-0008).
   Integration tests that mutate git run on disposable temp repos only.
4. **Review.** Spawn `conventions-reviewer`. Also spawn `safety-reviewer` if
   the change touches `src/git/**` or `src-tauri/src/git_runner.rs`. They are
   read-only; you apply the fixes.
5. **Fix** every critical and major finding. Push back only with evidence.
6. **Gate.** Suite green AND no unresolved critical/major → done. Else return
   to 2. **Cap: 3 passes.** Still red after the third? Stop and report the
   failing output, the hypothesis, and the next thing you'd try.
7. Commit (`/commit` style: single-line subject, no body, no trailers) and
   check off the matching `docs/ROADMAP.md` item in the same commit.

## Rules

- Never make the gate pass by deleting, skipping, or weakening a test.
- Never report "done" without pasting the real test output you saw.
- Out-of-scope discoveries go to `docs/ROADMAP.md` § Backlog, one line each.
- If the loop reveals the task was mis-specified, stop and say so — grinding
  a wrong task to green is the expensive failure mode.
