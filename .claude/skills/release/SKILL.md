---
name: release
description: Ship a release end to end — push main, let CI cut the version and build the installers, write the notes, publish the draft as Latest, and confirm the site and update manifests advertise it. Use when the user asks for a release, to ship, to publish, to promote, or to distribute to everyone.
allowed-tools: Bash, PowerShell, Read, Grep, Glob, Edit, Write
---

# Release

The pipeline is mostly automated; this skill drives it and checks every hand-off,
because each stage has failed silently at least once (see the comments in the
workflows and `docs/PROGRESS.md` § Released).

```
push main ─▶ version.yml ─▶ tag vX.Y.Z-alpha + chore(release) commit
                         └▶ release.yml (dispatched on the tag): lint, format,
                            tests, clippy, installers, signatures ─▶ DRAFT release
human: notes + publish ─▶ publish.yml ─▶ pages.yml on main ─▶ site + update
                                                              manifests (auto-update)
```

"Promote / distribute to everyone" means: publish the draft as a **full
release marked Latest** (not prerelease). Pages resolves "latest" with
`gh release view`, which skips drafts and prereleases, so anything else
reaches nobody.

## Steps

1. **Preflight (local).**
   - `git status` must be clean; uncommitted work goes through `/commit` first.
   - `git fetch --tags origin` and `git status -sb`. If behind (the bot's
     `chore(release)` commit lands on `main` after every cut), `git rebase
     origin/main` — never merge, never force push.
   - The suite should already be green from the task loop. If anything since
     the last green run touched code, run `npm test` and `npx tsc -b` now — a
     red release build costs half an hour.
   - Note the last *published* release: `gh release list --limit 5`. Older
     drafts may be sitting there unpublished; their commits ship in this one.

2. **Push.** `git push origin main`. This is the trigger — no manual tag.
   - `gh run list --workflow version.yml --limit 1`, then
     `gh run watch <id> --exit-status`.
   - It skips (green, no tag) when nothing but docs changed. Then there is
     nothing to release — say so and stop.
   - Bump comes from commit subjects (`scripts/version.mjs`): pre-1.0, `feat`
     and breaking (`!` / BREAKING CHANGE) → minor, anything else → patch.

3. **Wait for the build.** `git fetch --tags origin`, newest tag is the release.
   `gh run list --workflow release.yml --limit 1`, then watch it (≈ 20–30 min;
   use `run_in_background` and wait for the notification rather than polling).
   - On failure: `gh run view <id> --log-failed`, fix on `main`, commit, push.
     The next push cuts the *next* version; the failed tag stays as an orphan
     draft-less tag — don't delete tags unasked.

4. **Write the notes.** The draft's body is the fixed unsigned-binaries
   warning plus an auto changelog that is empty (no PRs). Add a
   `## What's new` section above it, from
   `git log --format=%s <last-published-tag>..<new-tag> --no-merges`
   minus `chore(release)` lines: one plain-English bullet per user-visible
   change, grouped New / Fixed. Keep it short — the first ~4 kB become the
   in-app update dialog's text. Keep the warning and the changelog link.
   - `gh release view <tag> --json body --jq .body > notes.md` (scratchpad),
     edit, then apply in step 5.

5. **Publish as Latest.**
   ```
   gh release edit <tag> --draft=false --prerelease=false --latest --notes-file notes.md
   ```
   Publishing is outward-facing and reaches every installed copy through the
   updater: do it only when the user asked to promote/distribute; otherwise
   leave the draft and report its URL.

6. **Verify distribution.**
   - `gh run list --workflow publish.yml --limit 1` → success, then
     `gh run list --workflow pages.yml --limit 1` → watch to success.
   - `curl -s https://leoddias.github.io/krakenless/updates/windows-x86_64.json`
     and `…/windows-x86_64-portable.json` name the new version, and every
     download URL in them answers 200 (`curl -sIL -o /dev/null -w '%{http_code}'`).
     There is no `jq` on this machine: grep for
     `releases/download/[^"]*` (a plain `https://github.com[^"]*` also
     matches the changelog link inside `notes`). Add `?x=$RANDOM` to dodge
     the Pages cache.
   - The landing page shows `Version <strong>X.Y.Z-alpha</strong>`.
   - If Pages failed, read its log: the usual causes are an asset the page
     links that the release lacks, or a missing `.sig`. Fix and re-run with
     `gh workflow run pages.yml --ref main`.

7. **Record.** `git pull --rebase` (to take the bot commit), then add the
   release under `docs/PROGRESS.md` § Released (date, version, what it
   carries, anything not verified by hand) and commit
   `docs: record vX.Y.Z-alpha release` via `/commit`, then push. A docs-only
   push does not cut another version.

## Report

Version, release URL, the notes' bullets, workflow results, the manifest
check, and anything left unverified (the update swap itself is only ever
proven by a human running an older build).
