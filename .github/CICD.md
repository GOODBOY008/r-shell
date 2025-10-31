# GitHub Actions CI/CD

This project uses GitHub Actions for automated testing and releases.

## Workflows

### 🧪 Test Workflow

**File**: `.github/workflows/test.yml`

Automatically runs on:
- Push to `main` branch
- Pull requests to `main` branch

**What it does**:
- Runs on both macOS and Windows
- Installs dependencies (Node.js, pnpm, Rust)
- Builds the frontend
- Runs Rust tests
- Runs Rust clippy for linting
- Checks Rust code formatting

### 🚀 Release Workflow

**File**: `.github/workflows/release.yml`

Automatically runs on:
- Tags matching `v*` (e.g., `v0.1.0`, `v1.0.0`)
- Manual trigger via workflow_dispatch

**What it does**:
- Builds release binaries for:
  - macOS (Apple Silicon - aarch64)
  - macOS (Intel - x86_64)
  - Windows (x86_64)
- Creates a GitHub release with binaries attached
- Generates a draft release for review

## Creating a Release

### Option 1: Tag-based Release (Recommended)

1. Update the version in `package.json` and `src-tauri/tauri.conf.json`
2. Commit the changes
3. Create and push a tag:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
4. The release workflow will automatically trigger

### Option 2: Manual Release

1. Go to Actions tab in GitHub
2. Select "Release" workflow
3. Click "Run workflow"
4. Select branch and click "Run workflow"

## Workflow Features

### Caching
- **Rust cache**: Speeds up Rust compilation using `swatinem/rust-cache`
- **pnpm cache**: Automatically handled by `pnpm/action-setup`

### Matrix Strategy
Both workflows use matrix strategies to test/build across multiple platforms:
- `macos-latest` - Latest macOS runner
- `windows-latest` - Latest Windows runner

### Platform-specific Dependencies
- **macOS**: Installs `pkg-config` via Homebrew
- **Windows**: No additional dependencies required

## Release Assets

When a release is created, the following assets are generated:

### macOS
- `r-shell_x.x.x_aarch64.dmg` - Apple Silicon installer
- `r-shell_x.x.x_x64.dmg` - Intel Mac installer
- Universal binary (combined, if implemented)

### Windows
- `r-shell_x.x.x_x64-setup.exe` - Windows installer
- `r-shell_x.x.x_x64.msi` - Windows MSI installer

## Permissions

The release workflow requires the following permissions:
- `contents: write` - To create releases and upload assets

## Environment Variables

The workflows use the following:
- `GITHUB_TOKEN` - Automatically provided by GitHub Actions

## Troubleshooting

### Build Failures

1. **Rust compilation errors**: Check the Rust cache and ensure all dependencies are correct
2. **Frontend build errors**: Verify Node.js version compatibility and pnpm lock file
3. **Platform-specific issues**: Check platform-specific dependency installation steps

### Release Issues

1. **Missing tag**: Ensure the tag follows the `v*` pattern (e.g., `v0.1.0`)
2. **Draft not appearing**: Check the Actions tab for workflow status
3. **Missing assets**: Verify the tauri-action step completed successfully

## Customization

### Adding More Platforms

To add Linux support, add to the matrix in both workflows:

```yaml
matrix:
  include:
    - platform: ubuntu-latest
      args: ''
```

And add Linux-specific dependencies:

```yaml
- name: Install dependencies (Ubuntu)
  if: matrix.platform == 'ubuntu-latest'
  run: |
    sudo apt-get update
    sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.0-dev libappindicator3-dev librsvg2-dev patchelf
```

### Customizing Release Notes

Edit the `releaseBody` in `.github/workflows/release.yml`:

```yaml
releaseBody: 'Your custom release notes here'
```

Or use a CHANGELOG file:

```yaml
releaseBody: 'See CHANGELOG.md for details'
```

## Best Practices

1. **Test before release**: Always create a PR and let tests run before merging
2. **Semantic versioning**: Follow semver (major.minor.patch)
3. **Review draft releases**: Check the draft release before publishing
4. **Keep dependencies updated**: Regularly update action versions
5. **Monitor workflow runs**: Check Actions tab for failures

## Related Documentation

- [Tauri GitHub Actions Guide](https://tauri.app/v1/guides/building/github-actions)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Tauri Action](https://github.com/tauri-apps/tauri-action)
