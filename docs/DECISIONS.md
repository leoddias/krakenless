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
