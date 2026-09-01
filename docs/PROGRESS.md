# Progress — living state

> Updated by every session via the `/handoff` skill. Newest session log first.
> This file is the handover between sessions and agents. Keep *Current state*
> and *Next up* truthful and short; move detail into the session log.

## Current state

- **Phase:** v0.1 feature-complete. Every buildable item in `docs/ROADMAP.md`
  M0–M5 is checked off; the only open item is the dogfood gate, which is two
  weeks of use, not code.
- **UI redesigned** (2026-08-20) to GitKraken's layout language — ADR-0017,
  with author pictures on the graph nodes (ADR-0018 derived badge, ADR-0021
  optional Gravatar/GitHub pictures) and resizable panels whose sizes persist
  (ADR-0020). Three passes of screenshot feedback are in.
- **Working-tree files can be edited in the app** (ADR-0022) — the first time
  Krakenless writes to a user's disk outside git. Read that ADR before touching
  `src-tauri/src/worktree.rs` or `src/fs/**`.
- **Verified in the running app**, by hand with screenshots: welcome + recent
  repos, history with the commit graph and ref decorations, working-tree panel
  (stage/unstage/discard/commit), diff viewer, remote bar, branches + stashes,
  conflict banner, settings, keyboard shortcuts, fs-watch refresh.
- **Test status:** `npm test` 1489 passing (67 files), `cargo test` 66 passing;
  oxlint, prettier and clippy clean. `cargo fmt` is *not* clean and never has
  been — see `docs/ROADMAP.md` § Backlog.
- **Git no longer runs on the UI thread** (ADR-0028). Every git command used to
  block the window for its duration — invisible for `status`, a frozen app for a
  `push`. `git_run` is now async over `spawn_blocking`. Any future command that
  waits on a network, a subprocess or a large file belongs there too.
- **Merge, worktrees, background fetch and a branch picker** landed on
  2026-08-27 — ADR-0025 through ADR-0029. None of them has been used by hand in
  the running app yet; see *Next up*.
- **`npm run build` must run before any cargo command** (ADR-0024): the frontend
  is compiled *into* the binary, and the codegen panics without `dist/`.
- **Right-clicking a commit opens a context menu** (ROADMAP § v0.2): checkout,
  branch/tag/annotated tag here, cherry-pick, revert, rebase the current branch
  onto it, reset it there (soft/mixed/hard), copy the sha, copy a remote link.
  Rebase and reset confirm first, and the git layer re-reads HEAD before running
  so a branch that moved between question and answer is refused.
- The discard path — the only code that takes work off disk — has integration
  tests that **execute the recovery command the UI displays**. Keep that
  property for any future change to `stage.ts` or `recovery.ts`.
- **A diverged branch is no longer a dead end** (2026-08-31, ADR-0035): push is
  blocked with the reason while behind, and Pull becomes a confirmed
  "Pull (merge)". New error kinds `diverged` / `non-fast-forward`.
- **The background fetch is observable and brings tags** (2026-08-31,
  ADR-0034 superseding ADR-0025): `--no-tags` is gone, `--no-prune-tags` is
  explicit, ref snapshots decide which panels refresh, and one notice names
  what arrived. Neither change has been used by hand in the running app yet.
- **The diff panel no longer freezes on huge commits** (2026-09-01): commit
  diffs are LRU-cached by root+oid (`src/state/diffCache.ts`), and rendering
  is budgeted (`src/views/diff/renderPlan.ts`) — large files collapse behind
  explicit reveal-in-chunks controls, a truncated hunk withholds its
  stage/discard buttons, and a stale in-flight diff can no longer land behind
  a newer selection. Not yet used by hand.
- **Test status now:** `npm test` 1784 passing (87 files); lint/format/tsc
  clean. Rust untouched since 0.1.7.
- **Not built:** conflict *resolution* UI, interactive rebase. Both are v0.2.

## Released

- **v0.1.8-alpha** (2026-08-31): published with all four installers and the
  landing page pointing at it (verified: pages workflow ran, portable asset
  answers). Carries ADR-0034/0035 but **not** the 2026-09-01 diff performance
  work — that is committed on `main` after the tag.
- **v0.1.2-alpha** (2026-08-21): the first build that actually contains the
  user interface — see ADR-0024 and the session log below. Published as a
  prerelease; the landing page's four download links point here and all four
  answer 200. Verified after the fact by downloading the published
  `x64_portable.exe` and finding `/assets/index-*.js` inside it.
- ~~**v0.1.1-alpha**~~ and ~~**v0.1.0-alpha**~~ (2026-08-20): **both shipped
  binaries with no UI in them**, and both were deleted from GitHub on
  2026-08-21. Their tags stay: the source at those tags is fine, it was the
  build that was broken.

## Next up (in order)

1. **Use the diverged-branch flow by hand** (ADR-0035): make a repo diverge,
   watch Push refuse with the reason, run "Pull (merge)" through its dialog —
   including a conflicted one. Also watch the background fetch tick (ADR-0034)
   report an arriving tag. Neither has been seen running, only asserted.
2. **Use the 2026-08-27 batch by hand.** All of it is tested and none of it has
   been run: a push while switching tabs (ADR-0028 — the whole point is that the
   window stays alive), dragging a branch chip onto the checkout to merge
   (ADR-0026), a repository with a real `git worktree` so the WIP row and the
   toolbar picker have something to show (ADR-0027), and pushing a tag
   (ADR-0029). The worktree row and the picker are the two that have never been
   *seen*, only asserted.
2. **Right-click a commit in the running app** — the context menu (ADR-less,
   ROADMAP § v0.2) has tests behind it but has never been used by hand. Worth
   checking the menu and its submenu near the bottom edge of the list, where the
   clamping code runs.
3. **Try the new editor on a real file** — it is the only code that writes to
   your disk, and it has not been used by hand yet. Consider a
   `safety-reviewer` pass over `src-tauri/src/worktree.rs` first.
4. **Look at the panels not yet seen running**: the diff, the working tree and
   its commit box, settings, welcome — plus dragging each edge, and the toolbar
   at narrow widths.
5. **The dogfood gate** (`docs/ROADMAP.md` § M5): use Krakenless as the only
   Git client for two weeks. Everything else in v0.1 is done, so this is the
   next real step and it produces the list that shapes v0.2.
6. Fix whatever the gate surfaces, in the order it hurts.
6. Then the validation checkpoint in `PLAN.md`: builds to 3–5 friends, and the
   decision to invest in v0.2 or stop.

## Blockers / open questions

- **Linux CI wedges the ubuntu runner** inside the Rust lib tests. Taken out of
  the CI gate on 2026-08-20 (not a v0.1 target); the bisecting workflow is
  `.github/workflows/linux.yml`, run on demand. Full findings and what was ruled
  out are in `docs/ROADMAP.md` § Backlog. Windows and macOS build and test green.

- None blocking. Two deliberate gaps, both documented in code comments:
  force-push is unreachable from the UI until the lease carries an explicit
  `<branch>:<oid>`, and pushing to a differently-named upstream is disabled
  until `buildPushCommand` emits a `<local>:<upstream>` refspec.

## Session log

### 2026-09-01 — the diff panel stops freezing on huge commits

A user clicked a commit with an enormous diff and the window locked up; going
back to it froze again. The git call was long done both times — the freeze was
the DOM (every line of every file mounted) and the absence of any cache (every
revisit re-fetched, re-transferred and re-parsed the patch). Fixed in two
layers, per /task-loop: `src/state/diffCache.ts` (16-entry LRU keyed by
root+oid, commit diffs only — immutable by construction; frozen in place so a
mutation of live diff state throws instead of poisoning the cache; cleared on
open and close) and `src/views/diff/renderPlan.ts` (pure planner: 400-line
per-file budget, 2,000-line panel budget, 1,000-line reveal chunks; slices
keep the original hunk object so nothing trimmed can ever reach `git apply`).
DiffView renders the plan with memoized line rows. Safety review found two
majors, both fixed with regression tests: a truncated hunk offered
stage/discard buttons acting on unseen lines (now withheld until the hunk is
fully shown), and the cache made the pre-existing selection race deterministic
— a slow diff resolving after the user moved on overwrote the panel (now a
still-current guard drops late answers). Conventions minors fixed (honest
collapse copy, dead `countLines` removed). Suite: 1784 passing, 87 files.
Touched: `src/state` (actions, new diffCache), `src/views/diff`. Backlog: the
giant patch still crosses IPC once per first visit — a `--stat`-first lazy
per-file flow would cap that.

### 2026-08-31 — the diverged dead end, an honest background fetch, 0.1.8-alpha

A user report drove both halves: pushing while behind errored, pulling errored
too, and only the CLI got them out. Root cause one: `pull --ff-only` plus a
rejected push left divergence with no in-app resolution. Fixed by ADR-0035 —
`diverged`/`non-fast-forward` error kinds classified from real git stderr,
push blocked in the UI while behind (reason in visible text), and a confirmed
"Pull (merge)" running `pull --no-rebase --ff --no-edit`, reusing the
`DialogHost`. Root cause two (parallel task-worker in a worktree): the
background fetch *was* wired but unobservable — silent by design, `--no-tags`
made pushed tags invisible forever, and one rejected tick killed the schedule
for the life of the window. Fixed by ADR-0034: tags follow fetched history,
`--no-prune-tags` guards against `fetch.pruneTags=true`, ref snapshots
(`for-each-ref`, new parser) gate the panel refreshes, and one notice names
what arrived; the manual Fetch button reports "Fetched: 1 new tag (v1.0)."
Both halves went through the full loop: safety-reviewer blocked once each
(prune-tags deletion; loose conflict sniff; tag rejection misread as
non-fast-forward) and every finding was fixed with a test. Suite: 1756
passing, 84 files. Touched: `src/git` (errors, refs, commands/remote, new
commands/refsnapshot + parser, confirm), `src/state` (actions, autoFetch, new
fetchNews), `src/views/remote`. Released: tag `v0.1.8-alpha` pushed;
`release.yml` was still building at handoff time — see *Next up* item 0.

### 2026-08-27 — freshness, merging, worktrees, and git off the UI thread

- **The app only ever showed what it had already been told.** Two separate
  causes, both reported as "I have to fetch by hand". The watcher's refresh
  re-read status, commits and diff only, so a branch or commit made in a
  terminal never reached the branch or stash lists; it now refreshes every
  panel. And nothing fetched, so another developer's work was invisible by
  construction — ADR-0025 adds a silent background fetch, five minutes by
  default, configurable to Off/1/5/15/30 in Settings. Silent means no busy flag,
  no notice on failure, skipped while an operation runs, and never overlapping
  itself.
- **Merge** (ADR-0026): `Merge <ref> into <branch>` on the commit menu, one item
  per branch on the row, plus dragging a branch chip onto the checked-out chip.
  `git merge --no-edit`, HEAD re-read first, conflicts reported as news rather
  than as an error. Dropping onto a branch that is *not* checked out is
  deliberately inert: that would mean checking it out first, and a 200px gesture
  must not move somebody's working tree.
- **Worktrees** (ADR-0027): `git worktree list --porcelain` plus one
  `git status` per linked worktree, drawn as a WIP row hanging off the commit
  that worktree has checked out, and offered in a new toolbar picker alongside
  the branches. The WIP row is a *synthesised* commit (`worktree:<path>`, one
  parent) inserted into the list the graph runs over — nothing may ask git about
  that oid, and `HistoryView` refuses to select the row for that reason. Read
  only: `worktree add` writes outside the repository and `remove` deletes files,
  neither of which belongs in the same pass as the view.
- **Git ran on the UI thread, and always had** (ADR-0028). A sync Tauri command
  executes on the thread that paints the window, so a push froze every tab until
  it finished. Now async over `spawn_blocking`. Background fetching would have
  made this much worse — every tab stalling the window on its own schedule.
- **A tag could be created and never published** (ADR-0029): `Push tag <name> to
  <remote>` on the menu, and an unticked "Push it to <remote>" in the create-tag
  dialog. Never `--force`; a tag other people have fetched is not moved silently.
- Sidebar sections (Branches / Local / Remote / Stashes) collapse, with the
  count staying on a closed header.
- Not done: none of this has been exercised in the running app, and `cargo fmt`
  is still not clean.

### 2026-08-21 — a commit context menu, and the releases that had no UI in them

- **Right-click a commit in the history.** New `src/git/commands/history.ts`
  (tag, cherry-pick, revert, rebase, reset, plus a `symbolic-ref` HEAD read) and
  `src/git/commits.ts`. Two rules shaped the git layer. **All three reset modes
  need a confirmation**, not just `--hard`: `isDestructive` only recognises the
  hard one from the arguments, but soft and mixed still take a branch off
  commits. And **rebase and reset re-read HEAD before running** — the menu item
  says "Reset *main* to this commit" and a dialog sits between the question and
  the command, so HEAD can move; if it did, nothing runs. Same guard the stash
  list uses for a shifted `stash@{n}`. `revert` carries `--no-edit` and an
  annotated tag demands a message, because the runner scrubs `GIT_EDITOR` but
  not `core.editor`, and a spawned editor would hang until the timeout.
  `commitWebUrl` strips `user:token@` from a remote before building a link.
  Deferred to ROADMAP § Backlog: interactive rebase and everything on top of it,
  worktree, patch, AI recompose; Cloud Patch is refused outright.
- **v0.1.0-alpha and v0.1.1-alpha shipped with no user interface** (ADR-0024).
  The user ran the portable download and got "localhost refused to connect".
  `tauri-macros` decides at compile time with
  `dev: cfg!(not(feature = "custom-protocol"))`, and without it
  `generate_context!` embeds `devUrl` instead of the files. `tauri build` passes
  that feature itself — so a local build was always correct and the defect was
  only observable by running a *published* artefact. Proven by inspection: the
  shipped exe holds no `/assets/index-*` keys and a plain `cargo build --release`
  reproduces it byte-for-byte in behaviour. **Why CI lost the feature was never
  reproduced** — `cargo test` before the build does not cause it locally, and the
  CI log shows `tauri-macros` recompiling; `rust-cache` sharing `target/` is the
  standing suspect. The fix sidesteps the question by declaring the feature in
  the manifest, and `release.yml` now greps the built binary for the asset
  filename `vite` just emitted. That check was tested against both binaries: it
  passes the new one and fails the one that shipped.

### 2026-08-20 (fourth pass) — an editor, real avatars, a fixed graph

Three pieces, two of them built in parallel worktrees and merged here.

- **Files in the working tree can be edited in the app** (ADR-0022). New Rust
  module `src-tauri/src/worktree.rs` — the only code in the product that writes
  a user's file outside git, so the guards *are* the module: the path must
  resolve inside the repository after symlinks are followed, `.git` is refused,
  a symlink is refused rather than followed (the atomic replace would turn it
  into a regular file), >2 MiB and non-UTF-8 are refused, and every write names
  the content fingerprint it expects to replace. `src/fs/text.ts` measures line
  endings, byte-order mark and trailing newline and restores them on save;
  mixed-ending files are refused, because a text box cannot represent the
  difference and saving would rewrite every line. The entry point is an "Edit"
  button in the diff panel's file header, working tree only.
- **Author pictures are real** (ADR-0021, supersedes part of ADR-0019): GitHub
  by account number for noreply addresses, Gravatar (SHA-256 of the address) for
  everyone else, derived badge underneath so a blocked request leaves a face.
  Cached at `%APPDATA%/krakenless/avatars/`, one request per identity ever,
  negative results cached too, 30-day expiry. Still off by default.
  **The old `githubAvatars: true` is deliberately not inherited** — that switch
  promised "no email address is ever sent anywhere" and this one does not, so
  the answer to the narrower question does not carry. One checkbox, re-ticked.
- **The commit graph drew dangling lines.** Two defects: edges had no vertical
  vocabulary, so a merge's second-parent lane got a full-height line starting at
  the row's top edge attached to nothing; and lanes were never freed on a
  rejoin, leaving an orphan slot drawing a line to a commit that never came.
  `GraphEdge` now carries explicit `from`/`to` anchors. The reviewer fuzzed
  30,000 random histories against `buildGraph` afterwards.
- Both packets were reviewed by `conventions-reviewer`; the avatar packet was
  blocked once by `safety-reviewer` and fixed (size caps, no redirects followed,
  fetch timeout, same-host check on `response.url`).
- `docs/ARCHITECTURE.md` gained two invariants that were previously untrue:
  where the app may write a file, and which network calls it may make.
- **Not reviewed:** the working-tree write path in `worktree.rs` has not been
  through `safety-reviewer`. The convention names `src/git/**` and the runner,
  which this is not — but it writes user files, which deserves the same bar.

### 2026-08-20 (redesign, third pass) — GitHub pictures, and draggable edges

- **Author pictures, opt-in** (ADR-0019). The user asked why we could not have
  GitKraken's photos; the answer is that GitKraken uses Gravatar or an OAuth
  integration, and both break the privacy rule. The middle path we took: a
  setting, off by default, that resolves *only*
  `<id>+<login>@users.noreply.github.com` — the id in that address is the account,
  so the URL is built locally and fetched by number. No email, no hash, no token,
  no account. The derived badge stays underneath, so a blocked or missing image
  still shows a face. The setting is `remoteAvatars` since ADR-0021, and reads
  as `false` unless the file says exactly `true`.
- **Every inner edge drags now** (ADR-0020): sidebar/graph, graph/diff,
  graph/working tree. `Splitter` is an ARIA `separator` with a tabindex and arrow
  keys, so it is not a mouse-only feature. Sizes persist in `config.json` under
  `layout`, written once per drag rather than per mouse-move, and clamped by the
  same `clampLayout` on the screen and on the file. The responsive stacking was
  deleted — dragging replaces it.
- Config fixtures in the tests now build from `defaultConfig()`; two of them had
  already broken on a new field this session.
- Tests at handoff: `npm test` 997 passing; oxlint and prettier clean.
- **Still not verified by eye**: the diff and working-tree panels, settings,
  welcome, and the drag behaviour itself.

### 2026-08-20 (redesign, second pass) — first look at it, and the fixes

- The user ran the redesign and screenshotted two overlaps and one gap.
- Columns were sized for text that git makes longer than assumed: the oid
  column held 7.5ch while git abbreviates to 9+ in a large repository, and the
  "when" column held 11ch against "14 minutes ago". Both spilled over their
  neighbour. Widened to 12ch and 14ch, with `overflow: hidden` so the next
  failure clips instead of overlapping.
- The header row drifted from its columns by the width of the scrollbar. The
  list now reserves the gutter (`scrollbar-gutter: stable`) and the header pads
  by the same 10px, so the two agree whether or not the list scrolls.
- Ref chips were clipped by the group rather than shrinking, which eats a chip's
  *first* letters — "HEAD" rendered as "D". Chips now shrink to a 4ch floor and
  ellipsize, and the column went 132px → 176px.
- Author badges on the graph nodes, asked for after GitKraken's avatars. They
  are computed locally — initials over a hue hashed from the author's email —
  because the only alternative is a Gravatar request per author, which the
  privacy rule forbids. Locked as ADR-0018. Lanes went 10px → 18px to fit.
- Tests at handoff: `npm test` 955 passing; oxlint and prettier clean.

### 2026-08-20 (redesign) — the front end, rebuilt to look like GitKraken

- Pure re-design, at the user's request: no feature added, removed or rewired.
- `src/index.css` is now a token sheet (surfaces, lines, text, accents, ref-chip
  colours, metrics, font stacks). Every view stylesheet was rewritten onto it;
  the hard-coded hexes that had crept into history, diff and welcome are gone.
- New shell in `App.tsx`: title bar with the repository as a tab, a toolbar that
  reads *repository → branch* with the remote actions as icon-over-caption
  buttons, and a status bar carrying the path and the busy state. The workspace
  is refs sidebar | graph over diff | working tree.
- `RemoteBar` became that toolbar cluster. Its hints are now described rather
  than drawn, but a *blocked* action still states its reason in visible text —
  one line per blocked action, in the strip under the toolbar. That property has
  tests counting the reason elements, and they still pass.
- History rows are a real table: fixed columns (refs, graph, subject, author,
  oid, when) under a header row, `ROW_HEIGHT` 44 → 30, selection drawn as a
  filled row plus an accent rail.
- Sidebar and working-tree rows fade their per-row buttons in on hover or focus
  (opacity, never `visibility`, so the keyboard keeps them).
- Icons are hand-written inline SVGs in `src/views/shell/icons.tsx`.
- Dropped the branch name from the status bar rather than loosening the App test
  it broke: the toolbar already says it, and two copies is two things to sync.
- Recorded as ADR-0017. Tests at handoff: `npm test` 939 passing, oxlint and
  prettier clean. `cargo test` untouched — nothing outside `src/` changed.
- **Not verified by eye**: no screenshot was taken this session.

### 2026-08-20 (later) — v0.1 finished, final safety pass

- Closed M3–M5: conflict banner, settings, About, keyboard shortcuts
  (Ctrl+1..4, Ctrl+R/F5, Ctrl+Enter, Ctrl+`,`, Ctrl+W), commit graph lanes.
- Final `safety-reviewer` pass blocked twice more, both times correctly:
  - `git stash push --include-untracked` stores the file in the stash's *third
    parent*, so the recovery command shipped for an untracked discard could
    never work. Fixed by resolving `^3` to a literal oid (never emitting `^`,
    which cmd.exe eats) and naming only paths the source tree actually holds.
  - The two facts the fix produced — "cannot restore this path", "no command
    for this discard" — were computed and dropped before reaching the screen.
  - `describeStash` walked the whole repository tree, so one undecodable
    filename anywhere made a discard fail *after* moving work off disk.
- Took the backlog items the reviewers filed: `state.remotes` read from
  `git remote` (an unfetched remote was invisible), and `busyDepth` as a
  counter so an overlapping write cannot re-enable destructive controls.
- Running the app found what tests could not: the graph reserved the widest
  lane count on every row and pushed commit subjects off the line.
- Fixed suite flakiness: the three integration files spawn dozens of git
  processes and exceeded Vitest's 5s default under the parallel runner.
- Also corrected a false claim I made to the reviewer — I reported view-layer
  tests that a silently-failed edit had never written. They exist now.
- Tests at handoff: `npm test` 935 passing, `cargo test` 36 passing.

### 2026-08-20 — M1–M4 built with parallel packets and capped loops

- Ran six task packets through `/fanout` (status/log/diff parsers; welcome,
  history and diff views; changes panel; remote bar; refs panel), each in its
  own worktree with `conventions-reviewer` and, where it touched git, the
  `safety-reviewer`. Every packet needed 2–3 loop passes before its gate passed.
- Built: the git layer contract, staging (including hunk-level via
  `git apply --cached`), remotes, branches, stashes, the fs watcher, config,
  store and actions, the app shell, settings, and the conflict banner.
- ADRs added: 0013 (capped loops + parallel packets), 0014 (oxlint), 0015 (path
  encoding decided at the runner), 0016 (destructiveness derived from args).
- The safety reviewer blocked three times and was right each time. Fixed, each
  with a test: the log record separator let a commit message forge a whole fake
  commit; discard destroyed the *staged* snapshot while advertising a
  `stash pop` that could not restore it; the replacement undo command
  (`git checkout <oid> --`) clobbered that same snapshot; force-push
  self-approved through a module-level `CONFIRMED` constant; stash operations
  addressed entries by a shifting index; the Rust runner reported a truncated
  read as an empty success.
- Running the app by hand found three things no test caught: settings were
  written to `dev.krakenless.app` rather than the documented folder, the diff
  panel opened empty, and history rows cut oids mid-hash.
- Also fixed a test-harness bug: `beforeEach(() => mock.mockReset())` returns
  the mock, and Vitest calls a returned function as teardown — so mocks were
  being invoked after every test. Six occurrences.
- Tests at handoff: `npm test` 881 passing, `cargo test` 32 passing.

### 2026-08-19 — Parallel harness + M0 scaffold (complete)

- Installed the Rust toolchain locally (rustup via winget; MSVC C++ tools were
  already present from VS 2022). `cargo build`, `cargo clippy -D warnings` and
  `cargo test` all pass; `npm run tauri dev` opens the window — M0 closed.
- README gained a full contributor setup section: prerequisite table, winget
  commands, non-Windows notes, the pre-PR gate, and troubleshooting.

- Added the parallel-work harness: `docs/PARALLEL.md` (task packets with
  disjoint owned globs, worktree isolation, orchestrator-only integration),
  `docs/TASKS.md` board, `/fanout` and `/task-loop` skills, `task-worker` and
  `conventions-reviewer` agents. Locked as ADR-0013; wired into `CLAUDE.md`.
- Scaffolded the app (M0): Vite react-ts template into the repo, strict
  tsconfig, Vitest + jsdom + Testing Library with a passing App test, Prettier
  (markdown excluded so agent docs stay stable), oxlint (ADR-0014), Tauri 2
  init with renamed crate/identifier/window size, CI workflow.
- Verified locally: `npm test` green, `npm run build` green, `npm run lint`
  clean, `npm run format:check` clean. **Not** verified: anything Rust.
- Scaffolding was deliberately kept single-agent — per PARALLEL.md, fan-out
  needs ≥2 disjoint packets and a settled contract; M0 had neither.

### 2026-08-19 — Design interview + harness
- Ran full design interview (grill-me). Resolved product identity, stack,
  scope, money model, safety bar, validation checkpoint → `PLAN.md`.
- Discarded the original Python/Typer/SQLite prompt (ADR-0001).
- Created agent harness: `CLAUDE.md`, `docs/` (PROGRESS, ROADMAP, DECISIONS,
  ARCHITECTURE, CONVENTIONS), skills (`handoff`, `adr`, `next-task`),
  `safety-reviewer` agent, README, `.gitignore`.
- No application code written yet.
