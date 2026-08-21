# Scripts Directory

This directory contains utility scripts for R-Shell development and maintenance.

## Version Bumping Scripts

### bump-version.mjs (Recommended)

**Cross-platform Node.js script** - Works on Windows, macOS, and Linux.

```bash
# Using npm scripts (recommended)
pnpm run version:patch
pnpm run version:minor
pnpm run version:major
pnpm run version:prerelease        # stable -> 2.8.0-beta.1, or 2.8.0-beta.1 -> 2.8.0-beta.2
pnpm run version:prerelease rc     # continue/switch the prerelease line (alpha|beta|rc|...)
pnpm run version:stable            # finalize a prerelease -> stable (2.8.0-beta.3 -> 2.8.0)
pnpm run version:verify v2.8.0     # verify a tag matches every version file

# Direct usage
node scripts/bump-version.mjs patch
node scripts/bump-version.mjs minor --no-commit
node scripts/bump-version.mjs major --skip-changelog
node scripts/bump-version.mjs prerelease beta
node scripts/bump-version.mjs stable
node scripts/bump-version.mjs minor --dry-run   # preview without writing
node scripts/bump-version.mjs minor --yes       # skip the confirmation prompt
```

**Features:**
- ✅ Cross-platform compatibility
- ✅ No shell dependencies
- ✅ Interactive confirmation (`--yes` to skip for CI/agents)
- ✅ `--dry-run` preview that writes nothing
- ✅ Preflight guardrails: refuses to bump with a dirty tree or out-of-sync version files (`--force` to bypass)
- ✅ Automatic git commit
- ✅ CHANGELOG.md template generation (inserts a section, or renames the release-line section on prerelease/stable)
- ✅ Stable (`major`/`minor`/`patch`) and tagged prerelease (`prerelease`/`stable`) bumps
- ✅ Cargo.lock updated by rewriting the root package entry (no full `cargo build` needed; falls back to `cargo build` and verifies the result)

### Bump Types

- `major` / `minor` / `patch` — stable release bump (`2.7.0 -> 2.8.0`); a fresh CHANGELOG section is inserted.
- `prerelease [identifier]` — tagged prerelease bump. From a stable version it opens the next minor line (`2.7.0 -> 2.8.0-beta.1`); from a prerelease it continues the same identifier (`2.8.0-beta.1 -> 2.8.0-beta.2`) or switches to another one at `.1` (`2.8.0-beta.3 -> 2.8.0-rc.1`). Identifier defaults to `beta`.
- `stable` — finalize a prerelease to its base version (`2.8.0-beta.3 -> 2.8.0`). Errors if the current version is already stable.

For `prerelease` / `stable`, the CHANGELOG section for the release line is **renamed** (e.g. `## [2.8.0-beta.2]` → `## [2.8.0-beta.3]`, or → `## [2.8.0]` on finalize, preserving the date) instead of inserting a new one each time, so draft notes carry over without accumulating duplicate sections. Insertion follows Keep a Changelog: right after the `Unreleased` section, or at the top when no `Unreleased` section exists.

### verify-release-tag.mjs

Checks that a release tag matches the version declared in `package.json`, `Cargo.toml`, `Cargo.lock`, and `tauri.conf.json`. Used by the Release workflow (`validate-tag` job) as a cheap failsafe before any build starts; also handy locally before tagging.

```bash
node scripts/verify-release-tag.mjs v2.8.0
node scripts/verify-release-tag.mjs v2.8.0-beta.1
# In CI the tag is taken from GITHUB_REF_NAME when no argument is passed.
```

Accepts `vX.Y.Z` and `vX.Y.Z-<prerelease>` tags; rejects build metadata and malformed tags. Exits non-zero with a per-file report on any mismatch.

### bump-version.sh

**Bash script** - For Unix-like systems (macOS, Linux, WSL).

```bash
./scripts/bump-version.sh patch
./scripts/bump-version.sh minor --no-commit
./scripts/bump-version.sh major --skip-changelog
```

**Features:**
- ✅ Fast shell-based execution
- ✅ Uses sed for in-place editing
- ✅ Colored output
- ✅ Same functionality as Node.js version

> ⚠️ The bash script supports only **stable** bumps (`major`/`minor`/`patch`). Use `bump-version.mjs` for prerelease (`prerelease [identifier]`) and finalize (`stable`) bumps.

## Options

`bump-version.mjs` supports:

- `--dry-run`: print the plan without writing anything or prompting
- `--yes` / `-y`: skip the interactive confirmation prompt
- `--force`: bypass the preflight guardrails (dirty tree, version drift)
- `--no-commit`: Update files without creating a git commit
- `--skip-changelog`: Don't update CHANGELOG.md
- `--help` / `-h`: show usage

The bash script (`bump-version.sh`) supports `--no-commit` and `--skip-changelog` only.

> ⚠️ `bump-version.mjs` runs two preflight checks before touching anything:
> 1. **Version drift** — all four version files must agree on the current version.
> 2. **Dirty tree** — no uncommitted *tracked* modifications (untracked files are fine).
> Both fail the bump with a clear message unless you pass `--force`.

## What Gets Updated

When you run a version bump script, it automatically updates:

1. **package.json** - Frontend package version
2. **src-tauri/Cargo.toml** - Rust package version
3. **src-tauri/Cargo.lock** - Root package version (edited directly when possible, `cargo build` fallback)
4. **src-tauri/tauri.conf.json** - Tauri app version
5. **CHANGELOG.md** - New version section (unless `--skip-changelog`)

## Usage Examples

### Quick patch bump
```bash
pnpm run version:patch
```

### Bump version without committing
```bash
pnpm run version:minor -- --no-commit
```

### Major version bump without CHANGELOG update
```bash
node scripts/bump-version.mjs major --skip-changelog
```

## Documentation

For detailed information about version bumping workflow, see:
- [docs/VERSION_BUMP.md](../docs/VERSION_BUMP.md) - Complete version bump guide
- [CHANGELOG.md](../CHANGELOG.md) - Version history

## Adding New Scripts

When adding new scripts to this directory:

1. Use clear, descriptive names
2. Add a header comment explaining the script's purpose
3. Make scripts executable: `chmod +x script-name.sh`
4. Document the script in this README
5. Add npm script shortcuts in package.json if appropriate

## Platform Compatibility

| Script | Windows | macOS | Linux |
|--------|---------|-------|-------|
| bump-version.mjs | ✅ | ✅ | ✅ |
| bump-version.sh | WSL/Git Bash | ✅ | ✅ |

**Recommendation:** Use `bump-version.mjs` (Node.js) for best cross-platform compatibility.
