#!/usr/bin/env node

/**
 * R-Shell Version Bump Script (Node.js version)
 * Cross-platform version bumping for Windows, macOS, and Linux.
 *
 * Usage:
 *   node scripts/bump-version.mjs <bump-type> [identifier] [--no-commit] [--skip-changelog]
 *
 * bump-type:
 *   major | minor | patch   -> stable release bump      (e.g. 2.7.0 -> 2.8.0)
 *   prerelease [identifier] -> tagged prerelease bump   (e.g. 2.7.0 -> 2.8.0-beta.1,
 *                                                        or 2.8.0-beta.1 -> 2.8.0-beta.2)
 *   stable                  -> finalize a prerelease    (e.g. 2.8.0-beta.3 -> 2.8.0)
 *
 * The `identifier` argument (alpha, beta, rc, ...) selects the prerelease line;
 * it defaults to `beta`. Releasing a prerelease uses `version:prerelease` /
 * `version:stable`, while stable releases use `version:patch|minor|major`.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import readline from 'readline';
import { fileURLToPath } from 'url';

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

/** Bump types that always land on a stable (non-prerelease) version. */
export const STABLE_BUMP_TYPES = ['major', 'minor', 'patch'];

const PRERELEASE_IDENTIFIER_RE = /^[0-9A-Za-z-]+$/;
const DEFAULT_PRERELEASE_IDENTIFIER = 'beta';

// ---------------------------------------------------------------------------
// Pure version math (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Parse a semver-ish string into { major, minor, patch, prerelease }.
 * The prerelease component (everything after the first `-`) is kept verbatim.
 */
export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(version).trim());
  if (!match) {
    throw new Error(`Invalid version string: ${version}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || null
  };
}

/** The core release line without any prerelease suffix: "2.8.0-beta.1" -> "2.8.0". */
export function baseVersion(parsed) {
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

/**
 * Advance a prerelease suffix within a line. Same identifier increments the
 * number ("beta.1" -> "beta.2"); a different identifier (or a fresh line)
 * starts at `.1` ("rc.1" -> "rc.1" when switching from beta to rc).
 */
export function nextPrereleaseTag(current, identifier) {
  const id = identifier || DEFAULT_PRERELEASE_IDENTIFIER;
  if (current) {
    const dot = current.lastIndexOf('.');
    const curId = dot === -1 ? current : current.slice(0, dot);
    const num = dot === -1 ? null : Number(current.slice(dot + 1));
    if (curId === id && Number.isInteger(num) && num > 0) {
      return `${id}.${num + 1}`;
    }
    return `${id}.1`;
  }
  return `${id}.1`;
}

/**
 * Compute the next version for a bump. Throws for impossible transitions
 * (e.g. `stable` from a version that is already stable).
 */
export function computeNextVersion(currentVersion, bumpType, identifier) {
  const parsed = parseVersion(currentVersion);
  const base = baseVersion(parsed);
  const isPrerelease = parsed.prerelease !== null;

  switch (bumpType) {
    case 'major':
      return `${parsed.major + 1}.0.0`;
    case 'minor':
      return `${parsed.major}.${parsed.minor + 1}.0`;
    case 'patch':
      return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
    case 'prerelease': {
      if (isPrerelease) {
        return `${base}-${nextPrereleaseTag(parsed.prerelease, identifier)}`;
      }
      // From a stable release, open a new prerelease line for the next minor.
      return `${parsed.major}.${parsed.minor + 1}.0-${nextPrereleaseTag(null, identifier)}`;
    }
    case 'stable': {
      if (!isPrerelease) {
        throw new Error(
          `Version ${currentVersion} is already stable. Use patch, minor, or major to bump it.`
        );
      }
      return base;
    }
    default:
      throw new Error(`Unknown bump type: ${bumpType}`);
  }
}

// ---------------------------------------------------------------------------
// CHANGELOG helpers
// ---------------------------------------------------------------------------

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sectionExists(changelog, version) {
  return new RegExp(`^## \\[${escapeRegex(version)}\\]`, 'm').test(changelog);
}

function renameSection(changelog, fromVersion, toVersion, date) {
  return changelog.replace(
    new RegExp(`^## \\[${escapeRegex(fromVersion)}\\]`, 'm'),
    `## [${toVersion}] - ${date}`
  );
}

function insertSection(changelog, version, date) {
  const newSection = `
## [${version}] - ${date}

### Added

- _Add new features here_

### Changed

- _Add changes here_

### Fixed

- _Add bug fixes here_
`;
  // Insert after the Unreleased section
  return changelog.replace(
    /(## \[Unreleased\][^\n]*\n\n[^\n]*\n\n)/,
    `$1${newSection}\n`
  );
}

/**
 * Add or update the CHANGELOG section for the bumped version.
 *
 * - Stable bumps (major/minor/patch) always insert a fresh section.
 * - Prerelease / stable-finalize bumps reuse the section for the same release
 *   line: rename an existing base ("## [2.8.0]") or current prerelease
 *   ("## [2.8.0-beta.2]") header so the notes drafted for one version carry
 *   over instead of accumulating duplicate sections.
 */
export function updateChangelog(changelog, currentVersion, newVersion, date, bumpType, skipChangelog) {
  if (skipChangelog) {
    return changelog;
  }

  if (STABLE_BUMP_TYPES.includes(bumpType)) {
    if (sectionExists(changelog, newVersion)) {
      return changelog;
    }
    return insertSection(changelog, newVersion, date);
  }

  // prerelease / stable: reuse the same release line's section when possible.
  if (sectionExists(changelog, newVersion)) {
    return changelog;
  }

  const base = baseVersion(parseVersion(newVersion));
  if (sectionExists(changelog, base)) {
    return renameSection(changelog, base, newVersion, date);
  }

  const curBase = baseVersion(parseVersion(currentVersion));
  if (curBase === base && sectionExists(changelog, currentVersion)) {
    return renameSection(changelog, currentVersion, newVersion, date);
  }

  return insertSection(changelog, newVersion, date);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// Run only when invoked directly (not when imported by tests).
function isDirectRun() {
  if (!process.argv[1]) {
    return false;
  }
  return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const bumpType = args[0] || 'patch';
  const noCommit = args.includes('--no-commit');
  const skipChangelog = args.includes('--skip-changelog');
  let identifier;

  // For `prerelease <identifier>`, the next positional arg is the identifier.
  if (bumpType === 'prerelease' && args[1] && !args[1].startsWith('--')) {
    identifier = args[1];
  }

  return { bumpType, identifier, noCommit, skipChangelog };
}

function main() {
  const { bumpType, identifier, noCommit, skipChangelog } = parseArgs();

  // Validate bump type
  if (!['major', 'minor', 'patch', 'prerelease', 'stable'].includes(bumpType)) {
    log.error(
      `Error: Invalid bump type '${bumpType}'. Use: major, minor, patch, prerelease [identifier], or stable`
    );
    process.exit(1);
  }

  if (identifier !== undefined && !PRERELEASE_IDENTIFIER_RE.test(identifier)) {
    log.error(
      `Error: Invalid prerelease identifier '${identifier}'. Use e.g. alpha, beta, rc (letters, digits, or hyphens)`
    );
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
  let newVersion;
  try {
    newVersion = computeNextVersion(currentVersion, bumpType, identifier);
  } catch (error) {
    log.error(`Error: ${error.message}`);
    process.exit(1);
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
    performBump({
      bumpType,
      noCommit,
      skipChangelog,
      currentVersion,
      newVersion,
      packageJsonPath,
      cargoTomlPath,
      tauriConfPath,
      changelogPath
    });
  });
}

function performBump({
  bumpType,
  noCommit,
  skipChangelog,
  currentVersion,
  newVersion,
  packageJsonPath,
  cargoTomlPath,
  tauriConfPath,
  changelogPath
}) {
  const rootDir = process.cwd();

  try {
    // Update package.json
    log.info('Updating package.json...');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
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
      const changelog = fs.readFileSync(changelogPath, 'utf8');
      const updated = updateChangelog(changelog, currentVersion, newVersion, today, bumpType, skipChangelog);
      fs.writeFileSync(changelogPath, updated);
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

if (isDirectRun()) {
  main();
}
