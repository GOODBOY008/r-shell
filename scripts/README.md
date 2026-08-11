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

# Direct usage
node scripts/bump-version.mjs patch
node scripts/bump-version.mjs minor --no-commit
node scripts/bump-version.mjs major --skip-changelog
node scripts/bump-version.mjs prerelease beta
node scripts/bump-version.mjs stable
```

**Features:**
- ✅ Cross-platform compatibility
- ✅ No shell dependencies
- ✅ Interactive confirmation
- ✅ Automatic git commit
- ✅ CHANGELOG.md template generation
- ✅ Stable (`major`/`minor`/`patch`) and tagged prerelease (`prerelease`/`stable`) bumps

### Bump Types

- `major` / `minor` / `patch` — stable release bump (`2.7.0 -> 2.8.0`); a fresh CHANGELOG section is inserted.
- `prerelease [identifier]` — tagged prerelease bump. From a stable version it opens the next minor line (`2.7.0 -> 2.8.0-beta.1`); from a prerelease it continues the same identifier (`2.8.0-beta.1 -> 2.8.0-beta.2`) or switches to another one at `.1` (`2.8.0-beta.3 -> 2.8.0-rc.1`). Identifier defaults to `beta`.
- `stable` — finalize a prerelease to its base version (`2.8.0-beta.3 -> 2.8.0`). Errors if the current version is already stable.

For `prerelease` / `stable`, the CHANGELOG section for the release line is **renamed** (e.g. `## [2.8.0-beta.2]` → `## [2.8.0-beta.3]`, or → `## [2.8.0]` on finalize) instead of inserting a new one each time, so draft notes carry over without accumulating duplicate sections.

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

Both scripts support the same options:

- `--no-commit`: Update files without creating a git commit
- `--skip-changelog`: Don't update CHANGELOG.md

## What Gets Updated

When you run a version bump script, it automatically updates:

1. **package.json** - Frontend package version
2. **src-tauri/Cargo.toml** - Rust package version
3. **src-tauri/Cargo.lock** - Updated via `cargo build`
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
