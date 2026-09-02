# Decision log (ADRs)

Append-only. To change a decision, add a new entry that supersedes the old
one (use the `/adr` skill). Format: number, date, status, decision, why,
consequences.

---

## ADR-0001 — Discard the Python/Typer/SQLite prompt
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** The original prompt (AI CLI: index repo → call model → propose
diffs) is not the product. Only its hygiene rules survive (local-first, no
telemetry, .env discipline, tests, import/export, honest UI states).
**Why:** It described an AI coding assistant competing with Aider/Claude Code
while explicitly excluding frontier model quality — unwinnable. The stated
goal ("replace GitKraken") requires a GUI.
**Consequences:** No Typer, no SQLite, no Python runtime in the product.

## ADR-0002 — Product identity: Git GUI; AI is an optional extra
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** Krakenless is a fast, private desktop Git GUI. AI features are
strictly optional, BYOK, from v0.2.
**Why:** GitKraken's real weaknesses are account requirement, subscription,
bloat, telemetry — not lack of AI. Never compete on model quality.

## ADR-0003 — Stack: Tauri 2 + React + TypeScript (Vite)
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** Tauri 2 shell (thin Rust), React+TS frontend.
**Why:** Small fast binary embodies the anti-bloat pitch; web frontend has the
best ecosystem for virtualized lists/diff viewers and the best AI-codegen
support for a vibecoded project. Flutter/Electron/PySide rejected (FFI cost /
bloat contradiction / packaging pain respectively).

## ADR-0004 — Git backend: shell out to system `git`
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** Execute the user's `git` binary with args arrays; parse
porcelain/`--format` output. No libgit2.
**Why:** Behavior-correct by definition; credentials (GCM/ssh-agent), hooks,
LFS work because it IS git. Users are developers; git being installed is fine.
**Consequences:** Parsers and command builders are the safety-critical core →
ADR-0008.

## ADR-0005 — App data: plain JSON in `%APPDATA%/krakenless`
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** Settings, recent repos, window state in human-readable JSON.
No database. Import/export = file copy.
**Why:** Git is the database for repo data; SQLite solved a problem this app
doesn't have. Revisit only as an optional graph cache for huge repos.

## ADR-0006 — Windows-first; cross-platform-capable stack
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** v0.1 builds and is tested on Windows only. Mac/Linux deferred
until a real user wants a build (Mac signing costs $99/yr — post-validation).

## ADR-0007 — v0.1 scope: core loop + hunk staging; conflicts = honest banner
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** In: open repo, graph, file+hunk staging, commit/amend,
push/pull/fetch, branches, stash, honest conflict banner with editor/mergetool
handoff. Out: conflict editor, interactive rebase, tabs, forge APIs, AI.
**Why:** Smallest thing that can replace GitKraken daily; hunk staging is half
the reason people open a Git GUI. Conflict editor would double time-to-dogfood.

## ADR-0008 — Testing bar: paranoid core, light UI
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** Every git-output parser and command builder is unit-tested
(Vitest); integration suite runs real git against disposable temp repos
covering the full loop incl. hunk staging. Destructive ops confirm in UI and
prefer recoverable forms. No window-driving e2e in v0.1.
**Why:** The app mutates repositories; a misparsed path in a `checkout --`
destroys work. Vibecoded discipline lives in the test suite.

## ADR-0009 — Money: donations only (phase 1); AGPL-3.0
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** Public repo + Sponsors/Ko-fi from day 1. Paid builds / open-core
reconsidered only after the validation checkpoint passes.

## ADR-0010 — "Krakenless" is a dev codename only
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** Rename before any public launch + donations push. The name
references Axosoft's GitKraken trademark; asking for money while invoking a
competitor's mark is the scenario that triggers cease-and-desists.

## ADR-0011 — Auth: inherit system git credentials
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** No credential storage in the app. HTTPS via Git Credential
Manager, SSH via user's agent — free consequence of ADR-0004. No forge OAuth
in v0.1.

## ADR-0012 — Validation checkpoint gates further investment
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** 2 weeks solo dogfood (GitKraken closed) → builds to 3–5 friends
→ ≥2 friends still using after 2 more weeks ⇒ invest in v0.2 + real name +
wedge. Otherwise stop investing; keep as personal tool.

## ADR-0013 — Work is executed as capped loops, parallelized by worktree packets
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** Every non-trivial task runs the loop build → test → review → fix
with a hard gate (green suite + no unresolved critical/major findings) and a
cap of 3 passes before it must escalate as blocked. Parallel work is done by
splitting a milestone into task packets with *disjoint owned file globs*, one
`task-worker` agent per packet in its own git worktree, integrated one at a
time by the orchestrator. Protocol: `docs/PARALLEL.md`.
**Why:** Agent-written code is cheap to produce and expensive to trust; the
bottleneck is verification, so verification is built into the unit of work
rather than left to a later pass. Worktree isolation with exclusive file
ownership is what makes concurrency safe without runtime coordination — the
alternative (several agents editing one tree) trades review time for merge
archaeology. The iteration cap exists because a loop that can't converge in 3
passes signals a mis-specified task, not insufficient effort.
**Consequences:** Splitting cost is paid up front (contracts committed before
fan-out); shared files are orchestrator-only, so workers *request* those edits.
Max 4 concurrent packets. Sequential single-agent work remains the default.

## ADR-0014 — oxlint instead of ESLint
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** Lint with oxlint (the Vite react-ts template's default); format
with Prettier, configured to leave markdown alone so docs stay stable across
agent sessions. Supersedes the "ESLint + Prettier" wording in ROADMAP M0.
**Why:** oxlint is what the current template ships, needs no plugin stack for
React/TS rules, and runs fast enough to sit in every task loop's gate. ESLint's
extra configuration surface buys nothing this project needs.
**Consequences:** Rules live in `.oxlintrc.json`. If a rule we need turns out to
be ESLint-only, add ESLint alongside rather than switching back.

## ADR-0015 — Path encoding and git invocation defaults are decided at the runner
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** Every git invocation is prefixed by the Rust runner with
`--no-pager -c core.quotePath=false`, runs with a scrubbed `GIT_*` environment,
and reports whether stdout decoded as valid UTF-8. Output that decoded lossily
is refused by the TypeScript runner unless the caller explicitly opts in, and
never for output that will be parsed into paths.
**Why:** Path quoting, paging and environment inheritance are properties of
*how git is called*, not of any single command; deciding them per builder means
the first author who forgets produces a parser that silently mangles non-ASCII
paths. Inherited `GIT_INDEX_FILE`/`GIT_DIR`-style variables can redirect writes
to a foreign index — launching the app from inside a rebase hook would be enough.
A lossy path fed back into a write command is the exact "misparse becomes data
loss" case the safety bar exists to prevent.
**Consequences:** Parsers may assume unquoted UTF-8 paths. Builders must not
re-specify these globals. Binary-ish output (e.g. `show` of a binary blob) needs
`allowLossyOutput` at the call site.

## ADR-0016 — Destructiveness is derived from the arguments, not declared
**Date:** 2026-08-19 · **Status:** accepted
**Decision:** `runGit` refuses to execute an unconfirmed command when either the
builder marked it destructive *or* `isDestructive(args)` recognizes it from the
argument array (`reset --hard`, `checkout/restore`, `clean`, `branch -D`,
`push --force`/`+refspec`, `stash drop|clear|pop`, `rebase`, `gc`, ...).
Supersedes the flag-only gate described in ADR-0008's original wording.
**Why:** A gate that depends on every future builder remembering a boolean fails
the first time someone forgets one — and the failure mode is an unconfirmed
`reset --hard`. Deriving it from the args makes the check mechanical at a single
chokepoint. The list is deliberately over-inclusive: a false positive costs one
confirmation dialog, a false negative costs the user's work.
**Consequences:** Read-only commands that happen to match must pass
`confirmed: true` explicitly, which is intentional friction.

## ADR-0017 — The UI follows GitKraken's layout language, driven by tokens
**Date:** 2026-08-20 · **Status:** accepted
**Decision:** The shell is five bands — title bar with the repository tab,
toolbar (repository → branch on the left, the remote actions as icon-over-caption
buttons, settings on the right), banners, workspace, status bar — and the
workspace is three columns: refs sidebar, the graph over its diff, and the
working tree as the detail panel. Every colour, radius and metric comes from the
tokens in `src/index.css`; view stylesheets may not hard-code a colour. Icons are
hand-written inline SVGs in `src/views/shell/icons.tsx` — no icon font, no
sprite, no network request.
**Why:** The product is positioned as the anti-GitKraken, which only works if a
GitKraken user recognizes the app on sight. The previous layout put four panels
side by side and captioned every toolbar button with a sentence, which read as a
form rather than a git client. Tokens exist so the palette can be retuned once,
and so a light theme has a single seam to cut along.
**Consequences:** A toolbar button's hint is now described, not drawn — but the
rule from ADR-0008's safety bar survives intact: an action that is *blocked*
still states its reason in visible text, in the strip under the toolbar, because
a disabled control can be neither focused nor hovered. Row actions in the
sidebar and the working tree are faded until hover or focus, never `visibility:
hidden`, so the keyboard still reaches them.

## ADR-0018 — Author avatars are derived locally, never fetched
**Date:** 2026-08-20 · **Status:** accepted
**Decision:** The graph node is drawn as the author's badge: initials over a
colour derived from a hash of their email (`src/views/history/avatar.ts`).
Krakenless does not request avatar images from Gravatar, GitHub, or any other
host. Adding such a lookup requires a new ADR superseding this one, and it would
have to be off by default and named for what it is.
**Why:** A commit carries a name and an email and no picture, so the only ways
to show a face are to ask a third party or to make one up. Asking means sending
a hash of the author's email — of *every* author on screen, on every scroll — to
a company the user never chose, from a product whose entire pitch is that it
makes no network calls except to git remotes. A derived badge gives the same
scanning benefit (one glance tells you who wrote a run of commits) for nothing.
**Consequences:** Two people whose emails differ get different colours even if
they are the same human; the badge is an identity marker, not a photograph.
Colour is derived from the email rather than the name so a contributor who
changes how they spell their name keeps one badge.

## ADR-0019 — GitHub pictures are opt-in, by account id, from the email alone
**Date:** 2026-08-20 · **Status:** accepted
**Decision:** A setting (`githubAvatars`, **off** by default) lets the graph
fetch author pictures from `avatars.githubusercontent.com`. It resolves only
`<id>+<login>@users.noreply.github.com` addresses, because the id in that address
*is* the account — the URL is built locally, requested by number, and no email,
hash of an email, token or account is involved. Everyone else keeps the derived
badge from ADR-0018, which stays underneath the picture so a blocked, offline or
missing image leaves a face rather than a hole. Refines ADR-0018; the local badge
remains the default and the only behaviour when the setting is off.
**Why:** The user asked for GitKraken's avatars. GitKraken gets them from
Gravatar (a hash of every visible author's email, sent to Automattic) or from an
OAuth integration (an account, which this product does not have). The noreply
form is the one case where the commit already tells us who the author is on
GitHub, so it buys most of the benefit at the smallest possible cost — one host,
contacted only for people who already chose to hide their address.
**Consequences:** The privacy rule now reads "no network calls except git
remotes, and avatar requests the user switched on". The About text in Settings
says so, and changes wording when the setting is on. Anything broader — Gravatar,
the GitHub API, GitLab — needs a new ADR; do not add it because it looks like a
small extension of this one. A malformed `githubAvatars` value in `config.json`
reads as `false`, because the safe reading of a broken privacy flag is the
private one.

## ADR-0020 — Panel sizes are the user's, and live in `config.json`
**Date:** 2026-08-20 · **Status:** accepted
**Decision:** The three inner edges — sidebar/graph, graph/diff, graph/working
tree — are draggable, and the sizes persist in `config.json` under `layout`.
Each edge is an ARIA `separator` with a `tabindex` and arrow-key support, so the
layout is not mouse-only. `clampLayout` is the single rule for what is allowed,
applied both while dragging and when reading the file. The width-based responsive
stacking is gone: the user resolves a narrow window by dragging.
**Why:** Fixed panels only fit the repository they were measured against — a
branch list of eighty names and a diff of long lines want opposite splits. Sizes
are written once per drag, not per mouse-move, so a drag is not hundreds of file
writes. Bounds exist so no panel can be dragged to a width it cannot be dragged
back from; a hand-edited config is pulled back inside them on read.
**Consequences:** `AppConfig` gained a `layout` object, so every config fixture
in the tests builds from `defaultConfig()` rather than listing fields. A failed
save costs the size, not the session — it is swallowed, and the layout on screen
stands.

## ADR-0021 — Author pictures come from Gravatar too, cached on disk, opt-in
**Date:** 2026-08-20 · **Status:** accepted
**Decision:** The opt-in author-picture setting is renamed `remoteAvatars` and
now covers everyone, not just GitHub noreply addresses. With it on, each author
is resolved once: `avatars.githubusercontent.com/u/<id>` when the commit email
is `<id>+<login>@users.noreply.github.com`, otherwise
`https://www.gravatar.com/avatar/<sha256 of the lowercased address>?s=32&d=404`.
`d=404` is required, so "this identity has no picture" stays distinguishable
from Gravatar's invented default. Every answer — the bytes, or the fact that
there is none — is written to `%APPDATA%/krakenless/avatars/<hash>.<ext>` and
stands for thirty days, so scrolling costs nothing. The fetch happens in the
webview; Rust (`avatars.rs`) only stores and returns bytes under a key it
validates as 64 hex digits. The locally derived badge (ADR-0018) stays
underneath every picture and is the only thing drawn when the setting is off.
**Supersedes the scope of ADR-0019** — the noreply path it defined survives
unchanged, as the first source tried; its promise that Gravatar would never be
contacted does not.
**Why:** The user asked for real pictures, and ADR-0019's answer only worked for
people who had turned on GitHub's email privacy — in their own repositories that
is nobody, so the feature showed nothing at all. Gravatar is the only way to
resolve an ordinary address without an account, and it costs a hash of that
address plus the user's IP. That is a real disclosure and it is theirs to make,
which is why the setting stays off by default, why the Settings copy names the
host and says that a hash identifies a person to anyone who already has their
address, and why the cache exists: the price is paid once per author, not once
per scroll. Thirty days for pictures and for "no picture" alike, because the
expiry is not about correctness — a month-old face is not a bug — but about how
often a decorative feature may touch the network.
**Consequences:** The privacy rule now reads "no network calls except git
remotes, and the author-picture requests the user switched on". `githubAvatars`
in an existing `config.json` is **not** inherited: an install that had the old
switch on starts with the new one off. Dropping a setting on a rename is rude,
and this was very nearly implemented the other way — but it is not really a
rename. The old switch was described to the user as fetching a picture by
account number with "no email address is ever sent anywhere"; the new one hashes
every author's address and sends it to Automattic. Inheriting the answer would
answer a question that was never asked, which is exactly the move this product
exists to not make. The cost is one checkbox, ticked once, beside copy that
says what now happens.
A malformed value still reads as `false`. A failed request caches nothing, so
being offline once does not cost a face for a month, while a 404 is cached.
Redirects are not followed: following one makes the onward request, which would
carry the hash and the IP to a host the user never agreed to, and checking
afterwards would be too late. If either host ever starts redirecting this
endpoint the picture is simply lost and the badge stays. Rust gained no HTTP
client — that is a dependency and its own decision — so a webview that blocks
the request (CORS, a proxy) simply leaves the derived badge showing.
## ADR-0022 — Krakenless may edit working-tree files, under a stamped write
**Date:** 2026-08-20 · **Status:** accepted
**Decision:** A file in the working tree can be edited in the app and written
back. The write path is a new Rust module, `src-tauri/src/worktree.rs`, and it
is the only code in the product that puts bytes on a user's disk outside git.
Its guards are the module: the path resolves inside the repository root *after*
symlinks are followed, nothing under `.git` is editable, a symbolic link is
refused rather than followed (the atomic replace would turn it into a regular
file), files over 2 MiB and files that do not decode as UTF-8 are refused, and
every write names the fingerprint of the bytes it expects to replace — a file
that changed on disk since it was opened is refused, not overwritten. The
replacement is written to a temporary file in the same directory and renamed
over the original. TypeScript owns what the bytes *mean*: `src/fs/text.ts`
measures the file's line endings, byte-order mark and trailing newline and
restores them on save, and refuses files with mixed endings, because a text box
reports every line the same way and saving would rewrite all of them.
**Why:** The user asked for it. It is a real reversal: `PLAN.md` puts a conflict
editor out of v0.1 and the product's answer to "I want to change this file" has
been "open your editor" ever since. The reversal is theirs to make, and the
feature earns its place — the common case is a one-line fix seen in a diff, and
bouncing to another program to make it is the kind of friction this client
exists to remove. What is *not* negotiable is the safety bar: writing a file is
the only operation here that git cannot undo, so the module ships with sixteen
Rust tests covering every refusal, including one proving that a stale save
leaves the newer file untouched.
**Consequences:** The privacy and scope claims in `PLAN.md` need rereading: this
app now writes files. The fingerprint is content-based (FNV-1a over the bytes),
not an mtime, because filesystem clocks are coarse enough that two edits inside
one tick share a timestamp. A successful save re-reads the diff, so a file whose
edit made it identical to HEAD disappears from the list and takes its editor
with it — correct, but abrupt. Anything richer than a text box (syntax
highlighting, an editor component) is a dependency and needs its own ADR.

## ADR-0023 — Several repositories at once, one store per tab
**Date:** 2026-08-20 · **Status:** accepted
**Decision:** Krakenless opens more than one repository. The title bar carries
one tab per open repository plus the app name, which is a button back to the
repository list; opening a repository that is already open activates its tab
instead of adding a second. Each tab owns its own `Store` — the tab list itself
is `src/views/shell/tabs.ts`, pure functions over an immutable list. Every open
tab stays mounted (hidden when it is not on screen) so its filesystem watch
keeps running and its panels stay current. Settings are *not* per tab: they are
published to every live store through `src/state/stores.ts`. Supersedes the
single-repository assumption in ADR-0007's v0.1 scope, which listed repo tabs as
out of scope.
**Why:** The user asked for it, and the shape was already half-built: the
redesign (ADR-0017) drew a tab strip for one repository because that is what
GitKraken looks like. Two things made it more than cosmetics. Multiple watches:
the Rust watcher held a single slot, so a second repository would have silently
stopped the first one's watch — it now keeps a map keyed by the token from the
watcher fix, and the change event carries that token so a change in one tab does
not re-read every panel of every other. And keyboard scope: every mounted pane
listened on `window`, so one Ctrl+W would have closed every repository at once;
only the pane on screen binds shortcuts, and panel focus is scoped to that pane
because every tab has a panel called "History".
**Consequences:** Repository paths are compared case-insensitively and with
separators normalised, so `C:/repos/App` and `C:\repos\app` are one tab. That is
deliberately wrong on a case-sensitive filesystem, and wrong in the safe
direction: one tab for one path, rather than two tabs writing to one index.
Nothing persists the open tabs yet — a restart comes back to the repository
list. N repositories mean N watchers and N sets of git processes on refresh;
there is no cap, and a user who opens twenty will feel it.

## ADR-0024 — The production feature is declared in the manifest, and the release proves the UI is in the binary

**Decision:** `src-tauri/Cargo.toml` declares
`default = ["custom-protocol"]` / `custom-protocol = ["tauri/custom-protocol"]`,
so any `cargo build --release` embeds the frontend rather than relying on the
Tauri CLI to pass the flag. Both workflows run `npm run build` before their
first cargo command, because the codegen now needs `dist/` to exist. And
`release.yml` gains a step that greps the built binary for the asset filename
`vite` just emitted, failing the release if it is absent.
**Why:** v0.1.0-alpha and v0.1.1-alpha both shipped binaries with **no user
interface inside them**. `tauri-macros` decides at compile time with
`dev: cfg!(not(feature = "custom-protocol"))`; without that feature
`generate_context!` embeds `devUrl` instead of the files, and the app opens
`http://localhost:1420`. On a developer machine with `npm run dev` running that
is invisible — the app looks perfect. Everywhere else it is a "connection
refused" page, which is what the user saw when they ran the portable download.
`tauri build` does pass `--features tauri/custom-protocol` (verified with
`--verbose`), so the local build was always correct and the defect could only
ever be observed by running a *published* artefact. Proven by inspection: the
shipped exe contains no `/assets/index-*` keys, and a plain `cargo build
--release` reproduces it exactly.
**Consequences:** Why CI lost the feature when a local `tauri build` does not
was **not** reproduced — `cargo test` before the build does not cause it here,
and the CI log shows `tauri-macros` recompiling for the release. `rust-cache`
sharing `target/` across runs is the leading suspect. The fix does not depend on
knowing: declaring the feature removes the CLI from the trust path entirely. The
cost is that `cargo test`, `cargo clippy` and `cargo check` now fail with "the
`frontendDist` configuration is set to `../dist` but this path doesn't exist"
until the frontend is built once — a confusing first-run error for a
contributor, which is why the manifest comment says so. Every published
v0.1.x-alpha artefact before this change is broken and should be replaced, not
just superseded.
## ADR-0025 — Krakenless fetches in the background, on by default, silently

**Status:** superseded by ADR-0034

**Decision:** The app runs `git fetch --no-tags --prune --all` against the open
repository every five minutes by default, configurable in Settings to Off, 1, 5,
15 or 30 minutes (`autoFetchMinutes` in `config.json`; `0` means off and starts
no timer at all). The fetch is silent: it never raises the busy flag, never
disables a control, and never reports a failure as a notice. It is skipped while
a user-started operation is in flight, skipped when the repository has no
remote, and never overlaps itself — the interval is a gap *between* fetches, so
a slow remote is never caught up on with a burst. Afterwards only what a fetch
can move is re-read: branches, commits, status and the remote list. The manual
Fetch button is unchanged and still reports errors.
**Why:** Nothing local can reveal that a colleague pushed a branch — git has
never been told it exists. The filesystem watcher answers "what changed on this
machine" and no amount of watching answers the other question, so before this
the branch list was only ever as fresh as the last manual fetch, and users were
clicking Fetch as a refresh button. On by default because a Git client that
shows a stale branch list by default is wrong in the way that costs people work,
and because a fetch to the user's own git remote is the one network destination
this app has always had (see ADR-0021 for the line: Gravatar and GitHub are
*not* that, and stay opt-in). Silent because the failure modes are a closed
laptop lid, a VPN that is not up and an SSH agent nobody has unlocked yet —
normal states that must not produce a notice every five minutes forever.
**Consequences:** A repository open in the app now generates periodic network
traffic and periodic authentication against the remote; a user on a metered
connection or with a credential prompt on every fetch has to turn it off, and
Settings says how. `--prune` deletes remote-tracking refs for branches removed
upstream, which is the point of it, and can never delete a local branch. A
background fetch and a user operation can still interleave on a slow remote —
the guard skips the tick only when the app is *already* busy, so an operation
started a millisecond later runs alongside a fetch. That is what git's own index
and ref locks exist for, and a fetch touches neither the index nor any local
ref. The fetch interval is honoured per open repository, so N tabs mean N
schedules and N processes; ADR-0023's "no cap" warning applies here too. One
interaction is deliberate and worth knowing: the post-fetch `refreshStatus`
marks the status stale for a few hundred milliseconds, and a discard confirmed
inside that window is refused with "could not check" rather than run, because
`ChangesView` treats stale as not knowing. Refusing to take work off disk
against an answer known to be out of date is the safe direction, and the user
simply confirms again.
## ADR-0026 — Merge is git's default merge, and a drag lands only on the checkout

**Decision:** The commit menu offers `Merge <ref> into <branch>` — one item per
branch on the row, or the sha when the row carries no branch — and a branch chip
in the graph can be dragged onto the chip of the checked-out branch to start the
same merge. Both run `git merge --no-edit <ref>`: fast-forward when git can,
merge commit when it cannot. No `--no-ff` variant, no `--squash`. The only drop
target is the branch that is checked out; dropping onto any other branch does
nothing. Every merge asks first, and the sentence the user reads is the
confirmation reason the git layer records. A conflicted merge is reported as a
warning notice naming what to do next, never as an error.
**Why:** "Merge that into what I am on" is the whole of what people came for,
and it is the one merge that needs no checkout, no stash and no explanation.
Dropping onto a branch that is *not* checked out is GitKraken's behaviour and it
means silently checking that branch out first — a 200px gesture that moves
somebody's working tree, which is exactly the class of thing this app asks about
rather than does. Defaulting to git's own merge rather than `--no-ff` keeps the
history the same shape the command line would have produced, so nobody has to
learn that this app decides differently. Conflicts are not failures: git stopped
where it always stops, the repository is mid-merge, and the conflict banner is
already on screen — calling it an error would contradict the banner beside it.
**Consequences:** Merging into a branch you are not on is a checkout away, and
the app does not shortcut it. `--no-ff` and `--squash` are unavailable from the
UI; if they are wanted they are a submenu on the same item, not a setting.
Drag-and-drop is a mouse gesture and inaccessible on its own, which is why the
identical merge lives on the context menu — the keyboard path is the menu, and
it must stay that way. Merge is deliberately *not* blocked over a dirty working
tree the way rebase is: git merges happily as long as no file it must write is
one the user edited, and refusing more than git does would refuse work git would
have accepted. The refusal git does produce is surfaced in its own words.
## ADR-0027 — Worktrees are shown and opened, never created or removed

**Decision:** The app reads `git worktree list --porcelain`, runs one
`git status` inside each linked worktree to count what is uncommitted there,
and surfaces the result in two places: a WIP row on the timeline hanging off the
commit that worktree has checked out, with the counts and an "Open Worktree"
control, and a branch/worktree picker in the toolbar. Picking a **branch**
checks it out here; picking a **worktree** opens that directory in a tab and
touches this checkout not at all. A branch another worktree holds is offered
disabled, naming the worktree that holds it. Nothing here writes:
`git worktree add` and `git worktree remove` are not built.
**Why:** A worktree is invisible in every other panel — the filesystem watcher
covers this checkout and nothing else — so the only evidence one exists is a
branch that mysteriously "cannot be checked out". The counts have to be asked
for one status at a time because that is the only way to learn them; they are
cheap (N worktrees, N processes) and they are what make the row worth drawing.
`add` and `remove` are excluded on purpose: `add` writes a directory outside the
repository, which is the boundary ADR-0022 exists to guard, and `remove` deletes
files off disk — the most destructive thing in the whole worktree surface, and
not something to ship in the same pass as the read-only view.
**Consequences:** The WIP row is a *synthesised* commit — oid `worktree:<path>`,
one parent, no author, no date of its own — inserted into the list the graph
layout runs over, which is what makes the stub connect to its commit. Nothing
may ask git about that oid: `HistoryView` refuses to select the row for exactly
that reason, and `isWorktreeRow` is the check. A worktree whose HEAD is not in
the loaded page gets no row at all, because a stub pointing at a commit that is
not on screen draws a line into nothing; it appears as soon as that commit
loads. "Open Worktree" goes through a module-level channel
(`state/openRequests.ts`) rather than a prop chain, because the tab list lives in
`App` and is the one place allowed to decide whether a path needs a new tab.
Counts are refreshed with everything else, so a repository with many worktrees
spawns that many `git status` processes per refresh — the same uncapped shape
ADR-0023 already warns about for tabs.
## ADR-0028 — Git runs off the UI thread

**Decision:** `git_run` is an `async` Tauri command whose body is handed to
`tauri::async_runtime::spawn_blocking`. It is not a plain `fn`, and it is not a
bare `async fn` either.
**Why:** Tauri executes a *synchronous* command on the main thread — the one
that owns the event loop and paints the window — so every git command this app
has ever run has blocked the entire UI for its duration. A `status` is
milliseconds and invisible; a `push` to a slow remote is tens of seconds during
which no tab can be switched, nothing repaints, and the app looks hung while it
is in fact working perfectly. That is what the user hit: a push in one tab froze
the other tabs. Background fetching (ADR-0025) made it worse by design — every
open tab would have stalled the window on its own schedule. `spawn_blocking`
rather than a bare `async fn` because the body genuinely blocks: it waits on a
child process and drains its pipes, and putting that on the async runtime's
worker threads would starve every other task as soon as a few tabs run git at
once. The blocking pool exists for exactly this shape of work.
**Consequences:** Several git commands can now be in flight at once, which is
what makes tabs independent — and which git's own index and ref locks are what
protect. Nothing in the frontend changed: `invoke('git_run', …)` returns the same
shape. A panicking task or a runtime shutting down comes back as `IoFailed`
rather than as an empty success, because "no output" is parsed downstream as
"no changes". The other commands (`config_*`, `avatar_*`, `worktree_*`,
`watch_repo`, `open_external`) are still synchronous: each is a bounded local
operation measured in milliseconds. Any future command that waits on a network,
a subprocess, or a large file belongs on the blocking pool for the same reason
this one does.

## ADR-0029 — A tag can be pushed, and never force-pushed

**Decision:** `Push tag <name> to <remote>` appears on the commit menu once per
tag on the row, in the same group as the items that create tags, and the
create-tag dialog offers "Push it to <remote>" as an unticked box. Both run
`git push --progress <remote> refs/tags/<tag>:refs/tags/<tag>`. There is no
force variant and no way to delete a remote tag from the app.
**Why:** `git push` does not carry tags with it. A tag made in this app existed
on one machine and nowhere else, with nothing in the UI to say so or to fix it —
which is how a release tag ends up living on somebody's laptop. The box is
unticked because a tag is often made to mark something locally long before
anyone else should see it, and because publishing one cannot be undone from
here. Fully qualified on both sides of the refspec for the reason the branch
push already is: a tag named `+v1.0` would otherwise be read as a force refspec.
**Consequences:** A tag the remote already has, pointing somewhere else, is
refused by git and the refusal is shown — moving a tag other people have already
fetched is an edit that appears in no diff, and this app will not do it
silently. The app cannot yet tell which tags the remote already has, so the item
is offered for every tag; pushing one that is already there and unchanged is a
no-op git reports as "Everything up-to-date". The remote is chosen the way the
copy-link item chooses it — first one, `origin` sorted first — so the menu never
offers two different answers to "which remote".
## ADR-0030 — The app knows which operation it is stopped in, and offers that one's way out

**Decision:** A new `src/git/operation.ts` reads what the repository is in the
middle of — rebase, cherry-pick, revert or merge — from git's own pseudo-refs
(`REBASE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `MERGE_HEAD`), with the
rebase counters read from `rebase-merge/`/`rebase-apply/` by a new Rust command
(`rebase_state`). The rebase directory is checked **first** and is the
authority. An `OperationPanel` sits where the commit box is and offers
`Continue`, `Skip commit` and `Abort` named after the operation actually
running; during a rebase it *replaces* the commit box. Continue runs with
`-c core.editor=true`. The conflict banner no longer owns any way out.
**Why:** Every conflict was treated as a merge. The banner said "merge" and its
only button ran `git merge --abort`, which during a rebase fails with "There is
no merge to abort (MERGE_HEAD missing)" — the user is stopped, detached, and
nothing in the UI can move them forwards or backwards. That is the worst state a
Git client can put somebody in. Rebase order matters because the merge backend
writes a `MERGE_HEAD` *too*, so asking about merges first reproduces the bug.
The counters come from files because the only git command that reports them
prints prose that git translates into the user's language. `core.editor=true`
because continuing opens an editor for the commit message and this process has
no terminal to host one — the command would hang until the timeout, mid-rebase.
**Consequences:** The commit box is hidden during a rebase, which is correct
(git makes that commit itself when the rebase resumes) and will surprise anyone
used to committing by hand mid-rebase. `Continue` is disabled while any path is
unmerged, with the count as the reason — git refuses too, and this says so
before the command runs rather than after. The Rust command reads only a fixed
allowlist of filenames under a caller-supplied git directory, and reports a
failure as "no rebase" so the refs still decide what may be offered. Interactive
rebase — reordering, squashing, `edit` — is still not built; this makes the
*conflict* path of a plain rebase survivable, which is what was breaking.

## ADR-0031 — Conflicts are resolved in the app, block by block, from the index

**Decision:** Clicking a conflicted file opens a full-window resolver: the two
sides side by side, a checkbox per differing block on each side, and an Output
pane showing the file that will be written. Save writes the assembled text
through the working-tree writer and then stages it. The sides are read from
index stages 2 and 3 (`git show :2:path`), never from the marked-up working
copy. Text that still carries conflict markers is refused before staging. Files
over 4000 lines a side are refused with a pointer to the merge tool.
**Why:** The app previously refused to help at all — "resolve these in your
editor first" — which is honest but leaves the most error-prone task in Git
outside the tool. The index stages are exact; the working copy's markers are
ambiguous, since a file may legitimately contain a line of seven angle
brackets. The Output pane is produced by the same `assemble` the Save button
writes, so what the user reads *is* the result rather than an approximation of
it. An undecided block contributes no lines, which makes a half-finished
resolution visibly incomplete instead of quietly defaulting to one side and
looking finished; Save stays disabled until every block is answered. The
marker check exists because `git add` on a marked-up file is the single most
common way a conflict reaches a commit.
**Consequences:** The pane labels swap round during a rebase — stage 2 is the
branch being rebased *onto* and stage 3 is the user's own commit — and
`sideLabels` is the one place that knows it; getting that backwards would throw
away somebody's work with a confident-looking UI. The block model is a plain
LCS over lines: quadratic, which is why the size guard exists, and predictable,
which is why it was not swapped for a heuristic. Binary files and delete/modify
conflicts are not served by this screen (there is no text to choose between);
they still need the merge tool or an editor. The trailing newline is carried
from the original rather than assumed. `resolveConflict` writes before staging,
never the reverse: staging first would, on a failed write, leave the index
claiming a resolution the file does not contain.

## ADR-0032 — Hunks are staged and discarded one at a time, and every diff entry knows its side

**Decision:** The diff panel offers per-hunk actions in each hunk header:
`Stage Hunk` / `Discard Hunk` on an unstaged entry, `Unstage Hunk` on a staged
one, and nothing on a commit. To make that possible every `FileDiff` now
carries a `side` (`'unstaged' | 'staged' | 'commit'`), stamped in
`src/git/diff.ts` by the function that chose the command; the parser returns
`ParsedFileDiff`, which has no side, because a patch reads identically whichever
comparison produced it. Staging and unstaging reuse the existing
`applyHunks` (`git apply --cached`, `--check` first). Discarding is new:
`discardHunks` writes the file's current bytes to the object store with
`git hash-object -w --no-filters`, runs `git apply --check --reverse`, then
`git apply --reverse` against the **working tree**, and returns the oid. The
app keeps that oid in a bounded store slice (`discards`) surfaced as a *Recent
discards* bar with an **Undo** button that writes the blob back itself. Discard
is offered only on the unstaged side; no hunk actions at all are offered for
binary, conflicted, renamed, copied or symlink entries; and discard in
particular is withheld for added, deleted and type-changed files. The reverse
patch is serialized with `target: 'worktree'`, which omits the file-level
`old mode`/`new mode` lines and positions each hunk by its parsed *new*-side
numbers.
**Why:** The panel concatenates the worktree and cached diffs, so one path can
appear twice and the two rows were previously indistinguishable — a button
there would have been a coin flip between staging and unstaging. The side is
the only thing that answers it, so it is carried as data rather than inferred.
Discarding a hunk is the sharpest operation in the app: unlike every other
discard it removes an edit git has never been told about, so there is no stash
and no reflog to fall back on, and the blob backup is the entire recovery
route — it is therefore taken *before* the apply, and a backup that fails to
produce an oid aborts the discard rather than proceeding unprotected.
`--no-filters` is load-bearing: with a clean driver or `core.autocrlf` in play
git would store normalised content, and restoring it would rewrite lines the
discard never touched.

The undo is a **button, not a printed command**. `git cat-file -p <oid> > path`
is byte-exact in `cmd.exe` and in `pwsh` 7, but in Windows PowerShell 5.1 — the
default shell on Windows 11, this app's primary platform — `>` is `Out-File`,
which re-encodes the stream as UTF-16LE with a byte-order mark and appends a
newline. Printing it would have handed the user a "recovery" that corrupts the
file it claims to restore. For the same reason the oid lives in the store
rather than in a notice: a notice is replaced by the very next operation, and
this oid is the only handle on work that has no stash, no reflog and no commit
behind it.

Symlinks are refused because a symlink's patch body is its *target string*:
restoring it by writing that text to the path follows the link and truncates
whatever it points at — a file outside the repository the user never selected.
Added files are refused because reverse-applying a `new file mode` patch
deletes the file from disk, which is not what the confirmation describes. Mode
lines are dropped from the reverse patch because they describe the file rather
than any hunk, so a one-hunk discard would otherwise silently revert an
executable bit the content backup cannot restore. Discard is withheld on the staged side because "discard"
there has two plausible meanings (drop from the index, or from both) and the
user cannot tell which they are getting; unstaging first makes the question
concrete. The refused file kinds are exactly the shapes `serializeHunks` throws
on — for a rename, a patch carrying only some hunks would record the content
without the rename.
**Consequences:** The undo command restores the **whole file**, not just the
discarded hunks, because that is the state that actually existed and can be
described honestly. `git apply --reverse` on the worktree is recognised as
destructive by `isDestructive()` from its arguments, independently of the
builder's flag. The dry run uses exactly the flags the real apply will use,
including `--unidiff-zero`, so it proves something about the apply that follows.
`--unidiff-zero` is decided with `every`, not `some`: it is a per-*patch* flag,
so one context-free hunk must not turn off git's position check for every other
hunk travelling with it.
`ParsedFileDiff` is what `serializeHunks` accepts, so the serializer stays
usable from tests and from parser output without inventing a side.

## ADR-0033 — The AI commit message comes from a CLI the user already trusts, not from an API client

**Decision:** An "AI Commit" button sits beside Commit. It runs a
user-configured program (`aiCommand`, default `claude`) with a fixed argument
list, writes the staged diff to that program's standard input, and puts the
one line it prints into the commit message box. Two settings exist: the program
and the model (`aiModel`, default `haiku`). Krakenless ships no HTTP client, no
API client library, and stores no credential. The button never commits.
Supersedes the "BYOK AI in v0.2+" clause of ADR-0021's privacy rule: there is
no key to bring.
**Why:** The app's whole architecture is "shell out to a binary the user
installed" — that is how it uses git, and it works here for the same reasons.
An in-app API client would need a key, and a key needs somewhere to live: the
config file is plain text the docs invite users to hand-edit, and an OS
keychain is a dependency and a new failure mode. Shelling out has none of that.
Authentication is the CLI's problem and it is already solved on the user's
machine; the app never sees a token, so it cannot leak one.

Every flag is load-bearing. `-p` makes it non-interactive — without it the CLI
opens a session and the app hangs until the timeout. `--restricted` removes the
tools that run commands or code: a commit-message button must not be able to
execute anything in the repository. `--no-session-persistence` keeps a private
diff out of a transcript on disk. `--system-prompt` *replaces* the CLI's own
prompt rather than appending, which drops the coding-agent preamble — cheaper
and less of an invitation to do more than answer. `--bare` is deliberately
absent despite looking right: it forces authentication to an API key and never
reads the CLI's own login, which is the one thing this design depends on.

The diff travels on **stdin**, never in the argument list, for the same reason
`git apply` reads a patch that way — an argument list is visible to every
process on the machine.
**Consequences:** The staged diff leaves the machine if the configured CLI
sends it somewhere. That is a real change to the privacy stance and it is
stated in Settings in those words, next to the field that causes it — the
honest framing is that the user chooses the tool and Krakenless hands it the
code. Nothing happens until the button is pressed, and an empty `aiCommand`
turns the feature off entirely.

The result is a *draft*: it lands in the message box and a person presses
Commit. That is the safety property the whole feature rests on, and it has a
test that fails if the button ever commits. It also makes prompt injection from
diff content a non-event — the worst case is a strange sentence the user reads
before accepting.

A patch over 60,000 characters is replaced by `git diff --cached --stat`, and
the UI **says so**. Truncating the patch instead would produce a confident
message about whichever files happened to come first, with nothing downstream
able to tell that had happened.

The Rust side reuses `run_capture`, extracted from `run_git`: the pipe-reader
threads, the process-tree kill and the bounded waits are the parts that hang or
silently truncate when copied, so there is one copy. `ai_runner` refuses a
program name containing whitespace — `claude --print` in that field is a
command line, and running it looks for a file of that literal name.

## ADR-0034 — The background fetch brings tags, says what it brought, and redraws only what moved (supersedes ADR-0025)

**Date:** 2026-08-31 · **Status:** accepted

**Decision:** The background fetch runs `git fetch --progress --prune
--no-prune-tags --all`. `--no-tags` is gone: a tag pointing into fetched
history now arrives, which is git's own default; `--tags` is still not passed.
`--no-prune-tags` is stated explicitly because `fetch.pruneTags=true` in a
user's config turns `--prune` into a tag deleter, and a tag created here and
never pushed is exactly what it deletes. Each tick re-reads the status
unconditionally; branches, commits and remotes are re-read only when a ref
actually moved, decided by comparing `for-each-ref` snapshots taken either
side of the fetch. When refs moved, one `info` notice names them — but never
over a warning or an error already on screen. Failure stays silent, as
ADR-0025 said, and a rejected tick no longer kills the schedule.

**Why:** A silent fetch that also redraws nothing is indistinguishable from
one that never runs, which is how a working schedule was reported as broken.
`--no-tags` made every tag anybody else pushed invisible forever. Refreshing
four panels twelve times an hour to redraw identical numbers costs processes
and blanks lists mid-scroll; the status is the exception because it is the
panel that lies loudest when stale. Rejected alternatives: `--tags` (drags
down every historic tag whether or not its commits arrived), refreshing
everything every tick (ADR-0025's behavior, the churn named above), and
keeping full silence (the bug report this supersession answers).

**Consequences:** Tags now arrive without being asked for. A repository whose
remote is busy produces a notice line per tick; a quiet one produces none.
The ref snapshot is two extra local git processes per tick and must never
become the input to a write path. The manual Fetch button now reports what
arrived ("Fetched: 1 new tag (v1.0).") instead of a bare "Fetch finished".

## ADR-0035 — A diverged branch resolves through a confirmed merge-pull, never an implicit one

**Date:** 2026-08-31 · **Status:** accepted

**Decision:** Pull stays `git pull --ff-only`. When the branch and its
upstream have diverged, the ff-only refusal and the push rejection are
classified as their own error kinds (`diverged`, `non-fast-forward`) with
actionable messages; push is blocked in the UI whenever the branch is behind,
with the reason in visible text; and the Pull button becomes "Pull (merge)",
which asks a confirmation naming both refs and both counts and then runs
`git pull --no-rebase --ff --no-edit`. The flags pin the strategy against
`pull.rebase` and `pull.ff=only` in the user's config: the sentence the user
agreed to describes a merge that rewrites nothing, so no config may quietly
turn it into a rebase or a refusal loop. A conflicted stop is an outcome, not
a failure — the conflict banner and merge-abort already handle it.

**Why:** Divergence used to be a dead end: push rejected, pull refused, and
the only way out was the command line — the exact failure a git GUI exists to
prevent. Rejected alternatives: defaulting pull to merge or rebase (makes a
history-shaping decision on the user's behalf, the thing `--ff-only` was
chosen to avoid); offering rebase as the escape hatch (rewrites commits under
a button labelled "pull"); force push (never offered, ADR unchanged); doing
nothing and improving only the error text (leaves the dead end in place).

**Consequences:** The merge-pull writes a merge commit the user did not
author, so it is only reachable through a confirmation dialog that mints the
token in the words shown. The push gate now refuses on `behind > 0` as of the
last fetch; a remote that rewound past that fetch makes the block
conservative, which is the only safe direction. Every new stderr pattern
ships with real-sample tests, including the negatives (a rejected tag push is
not "non-fast-forward"; a refname echoing the divergence sentence is not
"diverged").

## ADR-0036 — Krakenless updates itself from its own GitHub releases, and never runs a binary it has not verified

**Date:** 2026-09-02 · **Status:** accepted

**Decision:** The app checks for a new version once per launch against a
static JSON manifest on the project's GitHub Pages site, and offers — never
performs — an update. Four rules bound it:

1. **The manifest is on Pages; the binaries are on the release.** Pages
   already deploys on `release: published`, which is the exact moment a
   release's assets acquire public download URLs. A draft release therefore
   advertises nothing. The alternative, `releases/latest/download/`, cannot
   work at all while every release is a prerelease.
2. **Nothing is executed without a valid minisign signature over its bytes.**
   The shipped binaries carry no Authenticode signature, so this is not
   defence in depth — it is the only proof of provenance there is. The
   installed path gets this from `tauri-plugin-updater`; the portable path
   verifies the same way, against the same public key, before the downloaded
   file is allowed anywhere near the running executable.
3. **Two manifests, not one.** `windows-x86_64.json` is the updater plugin's
   own format; `windows-x86_64-portable.json` is this project's. Extending
   the first with extra keys would stake the portable path on an undocumented
   property of the plugin's deserializer.
4. **Checking is a setting; installing is a question.** `autoUpdateCheck`
   defaults to on and is one unauthenticated GET of a static file — no
   identifier, no request body, no second request when the version matches.
   Turning it off makes the app issue no request at all. Downloading and
   installing always require a click.

The portable executable updates itself by exploiting the one thing Windows
permits against a running image: it can be *renamed*, only not deleted or
overwritten. The new file is downloaded beside the current one, verified,
checked for a PE header, and only then swapped in by two renames, with the
first reversed if the second fails. The displaced file is deleted on the next
launch.

Installed builds are told apart from portable ones by a marker file shipped
as a bundle resource. Installers copy resources next to the executable; a
`krakenless.exe` copied out of `target/release` has no neighbours. When the
marker is absent but the executable sits in a managed install location, the
kind is `unknown` and self-replacement is refused rather than guessed.

**Why:** Every install of an alpha is a machine that will silently stay on an
alpha. The portable build makes that worse, not better: it is the download
for people who cannot install software, so it is the one least likely to ever
be replaced by hand, and leaving it out would have meant shipping an updater
that skips the users who most need it. Rejected alternatives: querying the
GitHub API from the app (rate-limited per IP, sends more metadata, and
duplicates discovery logic the plugin already has for the installed case);
attaching the manifest to the release itself (only works once releases stop
being prereleases); a manual "Check for updates" button alone (honest, and in
practice never clicked); shipping the updater for installers only (abandons
the portable users); trusting the download because it came from
`github.com` over TLS (transport security says the bytes arrived intact from
whoever GitHub handed them over for, not that this project built them).

**Consequences:** The privacy rule now reads "no network calls except git
remotes, opt-in author pictures, and one update check that the user can turn
off." The signing key becomes release infrastructure: losing it means no
already-installed copy can ever be updated again, and leaking it means an
attacker who can also serve the manifest can ship a signed binary. It lives
only in GitHub Actions secrets, and the public key is compiled into the app,
so moving to a new key requires a release users install by hand. The release
workflow signs the portable executable separately — the bundler signs what it
bundles, and the portable executable is not a bundle. The Pages workflow
gains a second job: it must fail the deploy if a manifest names an asset the
release does not hold, for the same reason the download links are already
checked. `updater.rs` is the only code in the project that writes an
executable file, which puts it under the safety bar: its swap, rollback and
sweep are unit-tested against real files on disk.

## ADR-0037 — The update manifest stays on Pages, for the real reason (corrects ADR-0036)

**Date:** 2026-09-02 · **Status:** accepted

**Decision:** ADR-0036's first stated reason is wrong and is withdrawn. It
claimed `releases/latest/download/` cannot serve the manifest "because every
release is a prerelease". Every release in this repository has
`prerelease=false`; they are *drafts* until published, and `v0.1.9-alpha` is
marked `isLatest=true`. A manifest attached as a release asset and fetched from
`releases/latest/download/` would in fact work.

The manifest stays on GitHub Pages anyway, on grounds that survive the
correction:

1. **It can be changed without cutting a release.** Pulling a bad build means
   editing one static file, not publishing a new version to every machine that
   already downloaded the old one. A manifest that lives inside the release it
   advertises cannot retract that release.
2. **The URL does not depend on release naming or on which release GitHub
   considers "latest"** — a rule that has draft, prerelease and publication
   date wound into it, and that this project has already misread once.

**Why this correction matters more than the conclusion:** the next person to
touch the updater would have inherited a false fact about how GitHub serves
releases and designed around it.

**Consequences, and one operational hazard found the same day:** a `release`
event runs the workflow **from the tag's commit**, not from the default branch.
So a fix to `pages.yml` only takes effect from the *next* tag onward — the
manifest generation for a release is frozen at whatever the tag contained. This
bit v0.1.10-alpha: its tag carries a manifest step that looks for a
`.nsis.zip`, an artefact Tauri 2 no longer produces, because it signs the NSIS
and MSI installers directly with a `.sig` beside each. For that release the
manifests are deployed by running the Pages workflow with `workflow_dispatch`
from `main`, whose dispatch path resolves "the latest release" itself. From
v0.1.11-alpha onward the tag carries the corrected step and no manual run is
needed. Anyone changing `pages.yml` release behaviour must remember it lands
one tag late.
