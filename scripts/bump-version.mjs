#!/usr/bin/env node

/**
 * R-Shell Version Bump Script (Node.js version)
 * Cross-platform version bumping for Windows, macOS, and Linux
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import readline from 'readline';

const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m'
};

const log = {
  info: (msg) => console.log(`${colors.blue}${msg}${colors.reset}`),
  success: (msg) => console.log(`${colors.green}${msg}${colors.reset}`),
  warn: (msg) => console.log(`${colors.yellow}${msg}${colors.reset}`),
  error: (msg) => console.log(`${colors.red}${msg}${colors.reset}`)
};

// Parse arguments
const args = process.argv.slice(2);
const bumpType = args[0] || 'patch';
const noCommit = args.includes('--no-commit');
const skipChangelog = args.includes('--skip-changelog');

// Validate bump type
if (!['major', 'minor', 'patch'].includes(bumpType)) {
  log.error(`Error: Invalid bump type '${bumpType}'. Use: major, minor, or patch`);
  process.exit(1);
}

// File paths
const rootDir = process.cwd();
const packageJsonPath = path.join(rootDir, 'package.json');
const cargoTomlPath = path.join(rootDir, 'src-tauri', 'Cargo.toml');
const tauriConfPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');
const changelogPath = path.join(rootDir, 'CHANGELOG.md');

// Read current version
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const currentVersion = packageJson.version;

log.info(`Current version: ${currentVersion}`);

// Calculate new version
const [major, minor, patch] = currentVersion.split('.').map(Number);
let newVersion;

switch (bumpType) {
  case 'major':
    newVersion = `${major + 1}.0.0`;
    break;
  case 'minor':
    newVersion = `${major}.${minor + 1}.0`;
    break;
  case 'patch':
    newVersion = `${major}.${minor}.${patch + 1}`;
    break;
}

log.success(`New version: ${newVersion}`);

// Prompt for confirmation
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question(`Bump version from ${currentVersion} to ${newVersion}? (y/n) `, (answer) => {
  if (answer.toLowerCase() !== 'y') {
    log.warn('Version bump cancelled');
    rl.close();
    process.exit(0);
  }

  rl.close();
  performBump();
});

function performBump() {
  try {
    // Update package.json
    log.info('Updating package.json...');
    packageJson.version = newVersion;
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');

    // Update Cargo.toml
    log.info('Updating src-tauri/Cargo.toml...');
    let cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
    cargoToml = cargoToml.replace(
      /^version = ".*"$/m,
      `version = "${newVersion}"`
    );
    fs.writeFileSync(cargoTomlPath, cargoToml);

    // Update tauri.conf.json
    log.info('Updating src-tauri/tauri.conf.json...');
    const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
    tauriConf.version = newVersion;
    fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');

    // Update Cargo.lock
    log.info('Updating src-tauri/Cargo.lock...');
    try {
      execSync('cargo build --quiet', { 
        cwd: path.join(rootDir, 'src-tauri'),
        stdio: 'ignore'
      });
    } catch (e) {
      // Ignore build errors, we just need Cargo.lock updated
    }

    // Update CHANGELOG.md
    if (!skipChangelog) {
      log.info('Updating CHANGELOG.md...');
      const today = new Date().toISOString().split('T')[0];
      let changelog = fs.readFileSync(changelogPath, 'utf8');

      const newSection = `
## [${newVersion}] - ${today}

### Added

- _Add new features here_

### Changed

- _Add changes here_

### Fixed

- _Add bug fixes here_
`;

      // Insert after the Unreleased section
      changelog = changelog.replace(
        /(## \[Unreleased\][^\n]*\n\n[^\n]*\n\n)/,
        `$1${newSection}\n`
      );

      fs.writeFileSync(changelogPath, changelog);
      log.warn('⚠️  Please update CHANGELOG.md with actual changes before committing');
    }

    // Create git commit
    if (!noCommit) {
      log.info('Creating git commit...');
      
      execSync('git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json');
      
      if (!skipChangelog) {
        execSync('git add CHANGELOG.md');
      }

      execSync(`git commit -m "chore: bump version to ${newVersion}"`);

      log.success(`✓ Version bumped to ${newVersion} and committed`);
      log.warn('Don\'t forget to:');
      console.log('  1. Update CHANGELOG.md with actual changes');
      console.log('  2. Run: git commit --amend (if needed)');
      console.log(`  3. Create a git tag: git tag v${newVersion}`);
      console.log('  4. Push changes: git push && git push --tags');
    } else {
      log.success(`✓ Version bumped to ${newVersion}`);
      log.warn('Files modified (not committed):');
      console.log('  - package.json');
      console.log('  - src-tauri/Cargo.toml');
      console.log('  - src-tauri/Cargo.lock');
      console.log('  - src-tauri/tauri.conf.json');
      if (!skipChangelog) {
        console.log('  - CHANGELOG.md');
      }
    }
  } catch (error) {
    log.error(`Error during version bump: ${error.message}`);
    process.exit(1);
  }
}
