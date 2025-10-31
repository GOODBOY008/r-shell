# Release Process

Quick reference for creating releases of r-shell.

## Prerequisites

- Write access to the repository
- All changes committed and pushed to main

## Steps

### 1. Update Version Numbers

Update the version in both files:

**package.json:**
```json
{
  "version": "0.2.0"
}
```

**src-tauri/tauri.conf.json:**
```json
{
  "version": "0.2.0"
}
```

### 2. Update Changelog (Optional)

Add release notes to `CHANGELOG.md`:

```markdown
## [0.2.0] - 2025-10-31

### Added
- New feature X
- New feature Y

### Fixed
- Bug fix A
- Bug fix B
```

### 3. Commit Changes

```bash
git add package.json src-tauri/tauri.conf.json CHANGELOG.md
git commit -m "chore: bump version to 0.2.0"
git push origin main
```

### 4. Create and Push Tag

```bash
# Create annotated tag
git tag -a v0.2.0 -m "Release v0.2.0"

# Push tag to trigger release workflow
git push origin v0.2.0
```

### 5. Monitor Workflow

1. Go to: https://github.com/GOODBOY008/r-shell/actions
2. Watch the "Release" workflow
3. Wait for all builds to complete (~10-20 minutes)

### 6. Review and Publish Release

1. Go to: https://github.com/GOODBOY008/r-shell/releases
2. Find the draft release
3. Review the generated assets:
   - macOS DMG files (Intel and Apple Silicon)
   - Windows installers (EXE and MSI)
4. Edit release notes if needed
5. Click "Publish release"

## Version Numbering

Follow [Semantic Versioning](https://semver.org/):

- **MAJOR** (1.0.0): Breaking changes
- **MINOR** (0.1.0): New features, backwards compatible
- **PATCH** (0.0.1): Bug fixes, backwards compatible

## Troubleshooting

### Build Failed

1. Check the Actions tab for error logs
2. Common issues:
   - Rust compilation errors
   - Missing dependencies
   - Code style violations (clippy)

### Tag Already Exists

```bash
# Delete local tag
git tag -d v0.2.0

# Delete remote tag
git push origin :refs/tags/v0.2.0

# Create new tag
git tag -a v0.2.0 -m "Release v0.2.0"
git push origin v0.2.0
```

### Manual Workflow Trigger

If automatic tagging doesn't work:

1. Go to Actions > Release workflow
2. Click "Run workflow"
3. Select branch
4. Click "Run workflow"

## Release Checklist

- [ ] Version updated in `package.json`
- [ ] Version updated in `src-tauri/tauri.conf.json`
- [ ] CHANGELOG.md updated (optional)
- [ ] Changes committed and pushed
- [ ] Tag created and pushed
- [ ] Workflow completed successfully
- [ ] Release draft reviewed
- [ ] Release published
- [ ] Social media announcement (optional)

## Quick Commands

```bash
# Full release in one go
VERSION="0.2.0"
sed -i '' "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" package.json
sed -i '' "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" src-tauri/tauri.conf.json
git add package.json src-tauri/tauri.conf.json
git commit -m "chore: bump version to $VERSION"
git push origin main
git tag -a "v$VERSION" -m "Release v$VERSION"
git push origin "v$VERSION"
```

## Notes

- Draft releases are created automatically
- Always review before publishing
- Binaries are automatically signed on macOS (if configured)
- Windows SmartScreen may show warnings for unsigned apps
