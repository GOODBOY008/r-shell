---
name: release-version
description: "Release a new r-shell version and create a published GitHub release with contributor credits. Use when: releasing, publishing, bumping version, tagging, creating release notes, gh release create, version bump, patch release, minor release, major release."
argument-hint: "bump type: patch | minor | major"
---

# Release New Version & Create GitHub Release

Bumps the project version across all config files, updates the CHANGELOG, pushes a tag, and creates a **published** GitHub release using `gh`, with release notes that credit the contributors.

## When to Use
- Releasing a new patch, minor, or major version of r-shell
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

Ask (or infer from the argument) whether this is a `patch`, `minor`, or `major` bump:

| Type | When | Example |
|------|------|---------|
| `patch` | Bug fixes, small tweaks | `1.2.3 → 1.2.4` |
| `minor` | New features, backward-compatible | `1.2.3 → 1.3.0` |
| `major` | Breaking changes | `1.2.3 → 2.0.0` |

### 2. Run the Version Bump Script

```bash
# Replace <type> with patch, minor, or major
pnpm run version:<type>
```

This updates **all four** version locations atomically and creates a git commit:
- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`
- `CHANGELOG.md` (adds a skeleton section)

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

```markdown

**Full Changelog**: https://github.com/GOODBOY008/r-shell/compare/v2.7.0...v2.8.0
```

After editing, amend the commit to include the updated CHANGELOG:
```bash
git add CHANGELOG.md
git commit --amend --no-edit
```

### 4. Create and Push the Git Tag

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

The release is created in a **published** state — visible immediately to users and triggering any release notifications/webhooks. Use `--notes-file` (not `--notes`) to pass multiline content reliably:
```bash
VERSION=$(node -p "require('./package.json').version")

gh release create "v${VERSION}" \
  --title "v${VERSION}" \
  --notes-file "${NOTES_FILE}" \
  --latest \
  --repo GOODBOY008/r-shell

rm -f "${NOTES_FILE}"
```

The `--latest` flag marks this release as the repo's current "Latest" release. Do **not** use `--draft` — the release should publish immediately.

> The release notes already include the `### Contributors` section added in step 3.

### 7. Verify

```bash
VERSION=$(node -p "require('./package.json').version")
gh release view "v${VERSION}" --repo GOODBOY008/r-shell
```

Check the output includes the release body text (not just "See the assets…"). If the body is empty, the notes file was empty or the `awk` pattern didn't match — re-run step 5 to debug, then use `gh release edit "v${VERSION}" --notes-file <file> --repo GOODBOY008/r-shell` to fix it.

## Decision Points

- **Changelog already accurate?** Skip step 3's changelog edits (but still add the `### Contributors` section) and the amend.
- **Want to keep the release hidden until you publish it manually?** Add `--draft` to the `gh release create` command in step 6.
- **Attaching build artifacts?** Add file paths after the tag in `gh release create`: `gh release create "v${VERSION}" ./dist/*.dmg ./dist/*.exe --latest ...`
- **Pre-release?** Append `--prerelease` to the `gh release create` command (this replaces `--latest`).

## Prerequisites

- `gh` CLI authenticated (`gh auth status`)
- `pnpm` installed
- Git remote `origin` points to `GOODBOY008/r-shell`
- On the `main` branch, synced with `origin/main` (fetch + fast-forward pull — see the note at the top of the Procedure)
- Clean working tree before starting (`git status`)
