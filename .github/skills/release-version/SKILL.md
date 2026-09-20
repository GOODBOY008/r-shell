---
name: release-version
description: "Release a new r-shell version and create a published GitHub release with contributor credits. Supports stable releases (vX.Y.Z), tagged prerelease versions (vX.Y.Z-beta.N / -rc.N), and evolution-line releases (vX.Y.Z-current.N). Use when: releasing, publishing, bumping version, tagging, creating release notes, gh release create, version bump, patch release, minor release, major release, prerelease, beta, rc, tagged release, stable release, current channel, evolution line."
argument-hint: "bump type: patch | minor | major | prerelease [identifier] | stable [--channel current]"
---

# Release New Version & Create GitHub Release

Bumps the project version across all config files, updates the CHANGELOG, pushes a tag, and creates a **published** GitHub release using `gh`, with release notes that credit the contributors. Two release kinds are supported:

- **Stable release** — `vX.Y.Z` (e.g. `v2.8.0`), published as the repo's **Latest** release. The Release workflow uploads `latest.json` (the in-app updater manifest) and updates the Homebrew cask, so every stable user sees it.
- **Tagged (prerelease) release** — `vX.Y.Z-<id>.<n>` (e.g. `v2.8.0-beta.1`, `v2.8.0-rc.1`), published as a GitHub **prerelease** (never Latest). The Release workflow skips `latest.json` and Homebrew for prerelease tags, so stable users are never offered a prerelease and Homebrew is untouched.
- **Evolution-line (current channel) release** — `vX.Y.Z-current.<n>` (e.g. `v3.0.0-current.1`), published as a GitHub **prerelease** with a reduced build matrix (mac arm64 on macOS 26+, Linux, Windows). The workflow uploads a `current.json` updater manifest under the rolling `current` tag and skips `latest.json` and Homebrew, so the stable channel and the cask never move. See the [Homebrew dual-baseline design](../../../docs/superpowers/specs/2026-09-12-homebrew-official-dual-baseline-design.md).

Both trigger the same `release.yml` build on a pushed `v*` tag; only the release **kind** differs. The workflow runs a `validate-tag` job first that fails fast if the tag is not a valid semver tag or does not match every version file, and it marks tagged prereleases as GitHub prereleases automatically (`prerelease: true`), so stable releases always stay the repo's "Latest".

## When to Use
- Releasing a new patch, minor, or major version of r-shell (stable)
- Releasing a tagged prerelease of r-shell (`-alpha`, `-beta`, `-rc`) before it goes stable
- Creating a GitHub release (published) with changelog notes and contributor credits
- Tagging a new version and pushing to origin

## Procedure

> **Start from `origin/main`:** the version bump and tag land on `main`, so a stale or non-`main` branch would tag the wrong commit. Before anything else, sync:
>
> ```bash
> git fetch origin
> git checkout main
> git pull --ff-only origin main
> git status   # abort if the working tree is dirty
> ```

### 1. Determine Bump Type

Ask (or infer from the argument) which kind of release this is:

| Bump type | Release kind | When | Example |
|-----------|--------------|------|---------|
| `patch` | Stable | Bug fixes, small tweaks | `1.2.3 → 1.2.4` |
| `minor` | Stable | New features, backward-compatible | `1.2.3 → 1.3.0` |
| `major` | Stable | Breaking changes | `1.2.3 → 2.0.0` |
| `prerelease` | Tagged | A pre-release of the next version | `2.7.0 → 2.8.0-beta.1` |
| `stable` | Tagged → Stable | Finalize a prerelease to stable | `2.8.0-beta.3 → 2.8.0` |
| `major` + `--channel current` | Evolution line | Open/continue the current channel | `2.9.3 → 3.0.0-current.1`, `3.0.0-current.1 → 3.0.0-current.2` |

For prereleases, an optional identifier selects the prerelease line (`alpha`, `beta`, `rc`, ...) and defaults to `beta`:
- `2.8.0-beta.1 → 2.8.0-beta.2` continues the same beta line
- `2.8.0-beta.3 → 2.8.0-rc.1` switches from beta to the rc line
- `2.8.0-beta.3 → 2.8.0` (via `stable`) promotes the prerelease to the stable release

On the `current` channel (only `major`/`minor`/`patch` bumps allowed):
- From a stable version, the bump opens the line's base: `2.9.3` + `major --channel current` → `3.0.0-current.1`
- From a `-current.<N>` version, the base is fixed and the bump type is ignored — the counter continues from the existing `v<base>-current.*` git tags (+1)
- Promotion to a new stable base happens on the stable channel (a normal `patch`/`minor`/`major` bump)

### 2. Run the Version Bump Script

The script is **non-destructive on preview**: run `--dry-run` first to confirm the target version and its CHANGELOG action without writing anything, then run it for real:

```bash
# Preview first (optional but recommended):
pnpm exec node scripts/bump-version.mjs <type> --dry-run

# Replace <type> with patch, minor, major, prerelease [identifier], or stable
pnpm run version:<type>
# e.g.:
pnpm run version:patch          # 2.7.0 -> 2.7.1 (stable)
pnpm run version:minor          # 2.7.0 -> 2.8.0 (stable)
pnpm run version:prerelease     # 2.7.0 -> 2.8.0-beta.1 (tagged)
pnpm run version:prerelease rc  # 2.8.0-beta.3 -> 2.8.0-rc.1 (tagged)
pnpm run version:stable         # 2.8.0-beta.3 -> 2.8.0 (finalize)
pnpm run version:major -- --channel current   # 2.9.3 -> 3.0.0-current.1 (evolution line)
```

The script enforces two **preflight guardrails** before touching anything (both bypassed with `--force` if you know what you are doing):
1. **Version drift** — `package.json`, `Cargo.toml`, `Cargo.lock`, and `tauri.conf.json` must all agree on the current version.
2. **Dirty tree** — no uncommitted *tracked* modifications (untracked files are fine), so the bump commit contains exactly the version change.

If the working tree is dirty (e.g. you have uncommitted version-draft edits), the bump will refuse — commit/stash, or run with `--force`. Use `--yes` to skip the interactive confirmation (useful when driving the bump from an automated agent).

This updates **all four** version locations atomically and creates a git commit:
- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`
- `CHANGELOG.md` (adds a skeleton section — for prerelease/stable/current-channel bumps it renames the existing release-line section instead of adding duplicates)

Read the new version from `package.json`:
```bash
node -p "require('./package.json').version"
```

### 3. Update CHANGELOG.md

**First, get the actual commits since the previous tag.** Find the previous tag and list every commit:
```bash
PREV_TAG=$(git tag --sort=-v:refname | sed -n '2p')   # second-newest tag
git log "${PREV_TAG}..HEAD" --oneline --no-merges
```

> ⚠️ **CRITICAL — Do NOT fabricate changelog entries.** Every bullet point MUST correspond to a commit in the output above. Do not copy bullets from older versions, do not invent features, and do not summarize the whole project history.

Open `CHANGELOG.md` and fill in the new version section that the script created. Replace the placeholder lines with actual release notes derived strictly from the commit list, grouped under the GitHub "What's Changed" sections:
- `### Breaking Changes 🛠` — breaking commits (`feat!:` / `BREAKING CHANGE`)
- `### New Features 🎉` — `feat:` commits
- `### Bug Fixes 🐛` — `fix:` commits
- `### Documentation 📚` — `docs:` commits
- `### Performance Improvements 🚀` — `perf:` commits
- `### Other Changes` — everything else (`refactor:`, `chore:`, `test:`, `build:`, `ci:`)

Omit a section when it has no entries.

**Format every entry as `type(scope): subject by @username in #PR`.** Resolve each commit's GitHub username and PR number:
```bash
# GitHub username for a commit SHA (author.login is the account that authored it):
gh api "repos/GOODBOY008/r-shell/commits/<sha>" --jq .author.login
# PR number — r-shell subjects usually carry "(#NN)"; fall back to the API:
gh api "repos/GOODBOY008/r-shell/commits/<sha>/pulls" --jq '.[0].number // empty'
```
If a commit's PR number can't be resolved, omit `in #PR`; if the author has no GitHub account, use the plain author name. Example:
```markdown
### New Features 🎉

- feat(connections): add password visibility toggles by @sunxiaobin89 in #77

### Bug Fixes 🐛

- fix(terminal): wire Edit menu to active terminal by @htazq in #57
```

Add a release headline as the first paragraph after the version header (see existing entries for the pattern: `### 🔖 R-Shell X.Y — Codename`).

The `**Full Changelog**` line must use the actual previous tag → new tag (for a prerelease, `PREV_TAG` is the previous tag and `NEW_TAG` is `v${VERSION}`, e.g. `v2.8.0-beta.1`):

```markdown
**Full Changelog**: https://github.com/GOODBOY008/r-shell/compare/<PREV_TAG>...<NEW_TAG>
```

> For a prerelease, the CHANGELOG section header is the exact prerelease version (`## [2.8.0-beta.1]`); it is renamed to `## [2.8.0]` when the prerelease is finalized. Evolution-line releases keep the full suffix as the header (`## [3.0.0-current.1]`), renamed on each current bump. Keep the notes under whichever header matches the version you are releasing.

After editing, amend the commit to include the updated CHANGELOG:
```bash
git add CHANGELOG.md
git commit --amend --no-edit
```

### 4. Create and Push the Git Tag

**Before tagging, verify the tag would match every version file** — this is exactly what the Release workflow's `validate-tag` job enforces, so catching it here saves a failed build:

```bash
VERSION=$(node -p "require('./package.json').version")
pnpm run version:verify "v${VERSION}"   # or: node scripts/verify-release-tag.mjs "v${VERSION}"
```

Then create and push the tag:

```bash
VERSION=$(node -p "require('./package.json').version")
git tag "v${VERSION}"
git push origin main
git push origin "v${VERSION}"
```

### 5. Extract Release Notes from CHANGELOG

Parse the new version's section from `CHANGELOG.md` and write it to a **temp file** (shell variable interpolation silently truncates multiline content, so always use a file):
```bash
VERSION=$(node -p "require('./package.json').version")
NOTES_FILE=$(mktemp /tmp/release-notes-XXXXXX.md)
awk "/^## \[${VERSION}\]/{found=1; next} found && /^## /{exit} found{print}" CHANGELOG.md > "${NOTES_FILE}"
```

**Verify the file is non-empty before proceeding:**
```bash
cat "${NOTES_FILE}"
# If empty, the awk pattern didn't match — check CHANGELOG.md header format is exactly ## [X.Y.Z]
wc -l "${NOTES_FILE}"
```

If the file is empty, do NOT continue — fix the CHANGELOG header format first.

### 6. Create the GitHub Release (Published)

The release is created in a **published** state — visible immediately to users and triggering any release notifications/webhooks. Use `--notes-file` (not `--notes`) to pass multiline content reliably.

**Stable release** (`v2.8.0`) — mark it `--latest` so it drives the in-app updater and becomes the repo's "Latest":

```bash
VERSION=$(node -p "require('./package.json').version")

gh release create "v${VERSION}" \
  --title "v${VERSION}" \
  --notes-file "${NOTES_FILE}" \
  --latest \
  --repo GOODBOY008/r-shell

rm -f "${NOTES_FILE}"
```

**Tagged (prerelease) release** (`v2.8.0-beta.1`, `v2.8.0-rc.1`, `v3.0.0-current.1`) — use `--prerelease` **instead of** `--latest`. Do **not** mark a prerelease as latest: the Release workflow's `upload-updater-json` and `update-homebrew` jobs skip prerelease tags, so leaving `--latest` off keeps the stable updater channel and Homebrew pointing at the last stable version.

```bash
VERSION=$(node -p "require('./package.json').version")

gh release create "v${VERSION}" \
  --title "v${VERSION}" \
  --notes-file "${NOTES_FILE}" \
  --prerelease \
  --repo GOODBOY008/r-shell

rm -f "${NOTES_FILE}"
```

Neither path uses `--draft` — the release should publish immediately.

> The release notes already include the `### Contributors` section added in step 3.

### 7. Verify

```bash
VERSION=$(node -p "require('./package.json').version")
gh release view "v${VERSION}" --repo GOODBOY008/r-shell
```

Check the output includes the release body text (not just "See the assets…"). If the body is empty, the notes file was empty or the `awk` pattern didn't match — re-run step 5 to debug, then use `gh release edit "v${VERSION}" --notes-file <file> --repo GOODBOY008/r-shell` to fix it.

**For a stable release**, also confirm it is marked "Latest" (`gh release view` shows the tag without a `prerelease:` line), so `releases/latest/download/latest.json` serves this version to the in-app updater.

**For a tagged (prerelease) release**, confirm:
- `gh release view` shows it as **Pre-release** (`prerelease: true` in the API: `gh api repos/GOODBOY008/r-shell/releases/tags/v${VERSION} --jq .prerelease`).
- `latest.json` was **not** attached to this release (check the assets list), and the stable `releases/latest` endpoint still points at the last stable release — stable users must not be offered a prerelease.

## Decision Points

- **Changelog already accurate?** Skip step 3's changelog edits (but still add the `### Contributors` section) and the amend.
- **Want to keep the release hidden until you publish it manually?** Add `--draft` to the `gh release create` command in step 6.
- **Attaching build artifacts?** Add file paths after the tag in `gh release create`: `gh release create "v${VERSION}" ./dist/*.dmg ./dist/*.exe --latest ...`
- **Stable vs tagged (prerelease)?** A stable release uses `--latest` and updates the in-app updater + Homebrew. A tagged prerelease (`-alpha`/`-beta`/`-rc`) uses `--prerelease` instead of `--latest`; the Release workflow skips `latest.json` and Homebrew for prerelease tags, so stable users and Homebrew are never switched to a prerelease. Finalize a prerelease with `pnpm run version:stable` before tagging it as `vX.Y.Z`.
- **Stable vs evolution line (current channel)?** A current-channel release (`vX.Y.Z-current.<N>`, bumped with `--channel current`) is also published with `--prerelease`, but it ships the reduced evolution-line build matrix and gets its own `current.json` manifest under the rolling `current` tag — `latest.json` and Homebrew stay on the stable line. Open the line from a stable version (`major --channel current`), continue it with any stable bump type (the base and bump type are ignored, only `<N>` advances), and promote back to stable with a normal bump on the stable channel.

## Promotion (current → stable)

Every 4–6 weeks the current line is frozen and promoted to a stable release:

1. `pnpm run version:minor` on `main` — a plain stable bump automatically strips the `-current.N` suffix (`3.0.0-current.3` → `3.1.0`).
2. Fill the new CHANGELOG section — the current line's unreleased features roll up into this stable entry.
3. Tag `vX.Y.0` and release as usual (`--latest`): full compat matrix (mac arm64 + Intel, Linux, Windows msi+nsis), `latest.json` refreshes and the Homebrew tap follows.

## Stable-release QA checklist

- [ ] **macOS 27 (latest major) manual QA** — no GitHub runner exists yet, and "works on the latest major macOS" is a hard requirement for any future Homebrew-official cask: launch the app, connect over SSH, type in a terminal, transfer a file over SFTP.
- [ ] `releases/latest` points at the new stable tag and `latest.json` reports the new version on all four platforms (stable channel intact).
- [ ] The Homebrew tap dispatch succeeded (`update-homebrew` job) and `brew info` shows the new version.

> Homebrew-official cask bump automation is **shelved** until notarization is in place — see the [dual-baseline design](../../../docs/superpowers/specs/2026-09-12-homebrew-official-dual-baseline-design.md) §3.5.

## Prerequisites

- `gh` CLI authenticated (`gh auth status`)
- `pnpm` installed
- Git remote `origin` points to `GOODBOY008/r-shell`
- On the `main` branch, synced with `origin/main` (fetch + fast-forward pull — see the note at the top of the Procedure)
- Clean working tree before starting (`git status`)
