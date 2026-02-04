# Version Bump Guide

This guide explains how to bump the version of R-Shell across all project files.

## Quick Start

### Using npm Scripts (Recommended)

```bash
# Patch version bump (0.6.2 → 0.6.3)
pnpm run version:patch

# Minor version bump (0.6.2 → 0.7.0)
pnpm run version:minor

# Major version bump (0.6.2 → 1.0.0)
pnpm run version:major
```

### Using the Script Directly

```bash
# Patch bump
./scripts/bump-version.sh patch

# Minor bump with options
./scripts/bump-version.sh minor --no-commit

# Major bump without updating CHANGELOG
./scripts/bump-version.sh major --skip-changelog
```

## What Gets Updated

The version bump script automatically updates:

1. **package.json** - Frontend package version
2. **src-tauri/Cargo.toml** - Rust package version
3. **src-tauri/Cargo.lock** - Updated via cargo build
4. **src-tauri/tauri.conf.json** - Tauri app version
5. **CHANGELOG.md** - New version section with template

## Script Options

- `--no-commit`: Update files without creating a git commit
- `--skip-changelog`: Don't update CHANGELOG.md

## Workflow Example

### 1. Bump Version

```bash
pnpm run version:patch
```

This will:
- Calculate the new version
- Ask for confirmation
- Update all version fields
- Create a CHANGELOG entry template
- Create a git commit

### 2. Update CHANGELOG

Edit `CHANGELOG.md` to replace the template with actual changes:

```markdown
## [0.6.3] - 2026-01-17

### Added

- ✨ New feature: SSH key management UI

### Changed

- 🔧 Improved connection restoration performance

### Fixed

- 🐛 Fixed memory leak in terminal component
```

### 3. Amend the Commit (if needed)

If you updated the CHANGELOG after the initial commit:

```bash
git add CHANGELOG.md
git commit --amend --no-edit
```

### 4. Create Git Tag

```bash
git tag v0.6.3
```

### 5. Push Changes

```bash
git push origin main
git push origin v0.6.3
```

## Manual Version Bump

If you prefer to bump versions manually, update these files:

1. **package.json**
   ```json
   "version": "0.6.3"
   ```

2. **src-tauri/Cargo.toml**
   ```toml
   version = "0.6.3"
   ```

3. **src-tauri/tauri.conf.json**
   ```json
   "version": "0.6.3"
   ```

4. **Update Cargo.lock**
   ```bash
   cd src-tauri && cargo build
   ```

5. **CHANGELOG.md**
   ```markdown
   ## [0.6.3] - 2026-01-17
   ```

## Semantic Versioning

Follow [Semantic Versioning 2.0.0](https://semver.org/):

- **Major (1.0.0)**: Breaking changes, incompatible API changes
- **Minor (0.7.0)**: New features, backward-compatible
- **Patch (0.6.3)**: Bug fixes, backward-compatible

## Changelog Format

Use the following categories in CHANGELOG.md:

- **Added**: New features
- **Changed**: Changes to existing functionality
- **Deprecated**: Soon-to-be removed features
- **Removed**: Removed features
- **Fixed**: Bug fixes
- **Security**: Security fixes

Use emojis for visual clarity:
- ✨ New features
- 🔧 Changes/improvements
- 🐛 Bug fixes
- 📁 File/data related
- 🔒 Security
- 📚 Documentation

## CI/CD Integration

The version bump process integrates with GitHub Actions:

1. Version bump commits trigger the release workflow
2. Git tags (v*) trigger automated builds
3. Release artifacts are created for all platforms

## Troubleshooting

### "sed: command not found"

The script uses `sed` which is available on macOS and Linux. For Windows, use WSL or Git Bash.

### "Permission denied"

Make the script executable:
```bash
chmod +x ./scripts/bump-version.sh
```

### Cargo.lock conflicts

If you encounter merge conflicts in Cargo.lock:
```bash
cd src-tauri
cargo update
```

## Example Commit Message

```
chore: bump version to 0.6.3

- Added SSH key management UI
- Improved connection restoration performance
- Fixed memory leak in terminal component
```
