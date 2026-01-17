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

# Direct usage
node scripts/bump-version.mjs patch
node scripts/bump-version.mjs minor --no-commit
node scripts/bump-version.mjs major --skip-changelog
```

**Features:**
- ✅ Cross-platform compatibility
- ✅ No shell dependencies
- ✅ Interactive confirmation
- ✅ Automatic git commit
- ✅ CHANGELOG.md template generation

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
