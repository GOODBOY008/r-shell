#!/usr/bin/env node

/**
 * R-Shell Version Bump CLI
 * Cross-platform version bumping for Windows, macOS, and Linux.
 *
 * All pure version/CHANGELOG logic lives in src/lib/version-bump.mjs (shared
 * with scripts/verify-release-tag.mjs and the unit tests); this file is the
 * thin CLI shell: argument parsing, preflight guardrails, file writes, and
 * the git commit.
 *
 * Usage:
 *   node scripts/bump-version.mjs <bump-type> [identifier] [options]
 *
 * bump-type:
 *   major | minor | patch   -> stable release bump      (e.g. 2.7.0 -> 2.8.0)
 *   prerelease [identifier] -> tagged prerelease bump   (e.g. 2.7.0 -> 2.8.0-beta.1,
 *                                                        or 2.8.0-beta.1 -> 2.8.0-beta.2)
 *   stable                  -> finalize a prerelease    (e.g. 2.8.0-beta.3 -> 2.8.0)
 *
 * options:
 *   --dry-run     show what would change without writing anything
 *   --yes, -y     skip the interactive confirmation prompt (CI/automation)
 *   --force       bypass the preflight guardrails (dirty tree, version drift)
 *   --no-commit   update files but do not create a git commit
 *   --skip-changelog  do not touch CHANGELOG.md
 *   --help, -h    print this usage text
 *
 * The `identifier` argument (alpha, beta, rc, ...) selects the prerelease line;
 * it defaults to `beta`. Releasing a prerelease uses `version:prerelease` /
 * `version:stable`, while stable releases use `version:patch|minor|major`.
 *
 * Preflight guardrails (fail fast, like semantic-release):
 *   - All four version files (package.json, Cargo.toml, Cargo.lock,
 *     tauri.conf.json) must agree on the current version before a bump.
 *   - The working tree must be clean of tracked modifications, so the bump
 *     commit contains exactly the version change and nothing else.
 * Both can be bypassed with `--force` when you know what you are doing.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import readline from 'readline';
import { fileURLToPath } from 'url';
import {
  STABLE_BUMP_TYPES,
  BUMP_TYPES,
  PRERELEASE_IDENTIFIER_RE,
  parseVersion,
  baseVersion,
  computeNextVersion,
  sectionExists,
  collectFileVersions,
  findVersionDrift,
  parseCargoLockVersion,
  updateCargoLock,
  updateChangelog
} from '../src/lib/version-bump.mjs';

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

// ---------------------------------------------------------------------------
// Preflight guardrail
// ---------------------------------------------------------------------------

/**
 * Inspect the working tree through git. Returns
 * { clean, hasGit, modifiedPaths, untrackedPaths } where clean means no
 * *tracked* modifications (untracked files do not block a bump).
 */
export function getWorkingTreeState() {
  let porcelain;
  try {
    porcelain = execSync('git status --porcelain', { encoding: 'utf8' });
  } catch {
    return { clean: true, hasGit: false, modifiedPaths: [], untrackedPaths: [] };
  }
  const lines = porcelain.split('\n').filter(Boolean);
  const untrackedPaths = lines
    .filter((line) => line.startsWith('??'))
    .map((line) => line.slice(3));
  const modifiedPaths = lines
    .filter((line) => !line.startsWith('??'))
    .map((line) => line.slice(3));
  return { clean: modifiedPaths.length === 0, hasGit: true, modifiedPaths, untrackedPaths };
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

const USAGE = `Usage:
  node scripts/bump-version.mjs <bump-type> [identifier] [options]

bump-type:
  major | minor | patch         stable release bump (2.7.0 -> 2.8.0)
  prerelease [identifier]       tagged prerelease bump (2.7.0 -> 2.8.0-beta.1,
                                beta.1 -> beta.2, or beta.3 + "rc" -> rc.1)
  stable                        finalize a prerelease (2.8.0-beta.3 -> 2.8.0)

options:
  --dry-run         show what would change without writing anything
  --yes, -y         skip the interactive confirmation prompt
  --force           bypass preflight guardrails (dirty tree, version drift)
  --no-commit       update files but do not create a git commit
  --skip-changelog  do not touch CHANGELOG.md
  --help, -h        show this help

examples:
  node scripts/bump-version.mjs minor
  node scripts/bump-version.mjs minor --dry-run
  node scripts/bump-version.mjs prerelease rc --yes
  node scripts/bump-version.mjs stable --no-commit
`;

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  const positional = argv.filter((arg) => !arg.startsWith('--') && arg !== '-y');
  const bumpType = positional[0] || 'patch';
  const identifier = bumpType === 'prerelease' ? positional[1] : undefined;
  return {
    bumpType,
    identifier: identifier && !identifier.startsWith('-') ? identifier : undefined,
    noCommit: argv.includes('--no-commit'),
    skipChangelog: argv.includes('--skip-changelog'),
    dryRun: argv.includes('--dry-run'),
    yes: argv.includes('--yes') || argv.includes('-y'),
    force: argv.includes('--force')
  };
}

function main() {
  const { bumpType, identifier, noCommit, skipChangelog, dryRun, yes, force } = parseArgs(
    process.argv.slice(2)
  );

  if (!BUMP_TYPES.includes(bumpType)) {
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

  const rootDir = process.cwd();
  const paths = {
    packageJson: path.join(rootDir, 'package.json'),
    cargoToml: path.join(rootDir, 'src-tauri', 'Cargo.toml'),
    cargoLock: path.join(rootDir, 'src-tauri', 'Cargo.lock'),
    tauriConf: path.join(rootDir, 'src-tauri', 'tauri.conf.json'),
    changelog: path.join(rootDir, 'CHANGELOG.md')
  };

  // --- Preflight: versions must agree across all four files ---
  const contents = {
    packageJson: fs.readFileSync(paths.packageJson, 'utf8'),
    cargoToml: fs.readFileSync(paths.cargoToml, 'utf8'),
    cargoLock: fs.readFileSync(paths.cargoLock, 'utf8'),
    tauriConf: fs.readFileSync(paths.tauriConf, 'utf8')
  };
  const versions = collectFileVersions(contents);
  const drift = findVersionDrift(versions);
  if (drift.length > 0 && !force) {
    log.error('Error: version files are out of sync before the bump:');
    for (const { file, version } of drift) {
      log.error(`  - ${file}: ${version} (package.json: ${versions['package.json']})`);
    }
    log.error('Fix the drift (or re-run with --force) before bumping.');
    process.exit(1);
  }

  // --- Preflight: clean tracked working tree ---
  const tree = getWorkingTreeState();
  if (tree.hasGit && !tree.clean && !force) {
    log.error('Error: the working tree has uncommitted tracked modifications:');
    for (const file of tree.modifiedPaths) {
      log.error(`  - ${file}`);
    }
    log.error('Commit or stash them first (or re-run with --force).');
    process.exit(1);
  }

  const currentVersion = versions['package.json'];
  log.info(`Current version: ${currentVersion}`);

  // --- Compute the next version ---
  let newVersion;
  try {
    newVersion = computeNextVersion(currentVersion, bumpType, identifier);
  } catch (error) {
    log.error(`Error: ${error.message}`);
    process.exit(1);
  }
  log.success(`New version: ${newVersion}`);

  // --- Plan the CHANGELOG action so --dry-run shows the full picture ---
  const changelog = fs.readFileSync(paths.changelog, 'utf8');
  const today = new Date().toISOString().split('T')[0];
  let changelogAction = 'skip (--skip-changelog)';
  if (!skipChangelog) {
    if (!STABLE_BUMP_TYPES.includes(bumpType)) {
      const base = baseVersion(parseVersion(newVersion));
      const curBase = baseVersion(parseVersion(currentVersion));
      if (sectionExists(changelog, newVersion)) {
        changelogAction = 'already present, no change';
      } else if (sectionExists(changelog, base)) {
        changelogAction = `rename section [${base}] -> [${newVersion}]`;
      } else if (curBase === base && sectionExists(changelog, currentVersion)) {
        changelogAction = `rename section [${currentVersion}] -> [${newVersion}]`;
      } else {
        changelogAction = 'insert new section';
      }
    } else if (!sectionExists(changelog, newVersion)) {
      changelogAction = 'insert new section';
    } else {
      changelogAction = 'already present, no change';
    }
  }

  log.info('Plan:');
  console.log(`  - ${Object.keys(versions).join(', ')}: ${currentVersion} -> ${newVersion}`);
  console.log(`  - CHANGELOG.md: ${changelogAction}`);
  if (dryRun) {
    console.log(
      `  - Commit: ${noCommit ? 'skipped (--no-commit)' : 'chore: bump version to ' + newVersion}`
    );
    log.info('Dry run - no files were modified.');
    return;
  }

  // --- Confirm ---
  if (!yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`Bump version from ${currentVersion} to ${newVersion}? (y/n) `, (answer) => {
      rl.close();
      if (answer.toLowerCase() !== 'y') {
        log.warn('Version bump cancelled');
        return;
      }
      performBump({ bumpType, noCommit, skipChangelog, currentVersion, newVersion, paths });
    });
    return;
  }

  performBump({ bumpType, noCommit, skipChangelog, currentVersion, newVersion, paths });
}

function performBump({ bumpType, noCommit, skipChangelog, currentVersion, newVersion, paths }) {
  const rootDir = process.cwd();

  try {
    // Update package.json
    log.info('Updating package.json...');
    const packageJson = JSON.parse(fs.readFileSync(paths.packageJson, 'utf8'));
    packageJson.version = newVersion;
    fs.writeFileSync(paths.packageJson, JSON.stringify(packageJson, null, 2) + '\n');

    // Update Cargo.toml
    log.info('Updating src-tauri/Cargo.toml...');
    let cargoToml = fs.readFileSync(paths.cargoToml, 'utf8');
    if (!/^version = ".*"$/m.test(cargoToml)) {
      throw new Error('Cargo.toml has no "version = ..." line');
    }
    cargoToml = cargoToml.replace(/^version = ".*"$/m, `version = "${newVersion}"`);
    fs.writeFileSync(paths.cargoToml, cargoToml);

    // Update tauri.conf.json
    log.info('Updating src-tauri/tauri.conf.json...');
    const tauriConf = JSON.parse(fs.readFileSync(paths.tauriConf, 'utf8'));
    tauriConf.version = newVersion;
    fs.writeFileSync(paths.tauriConf, JSON.stringify(tauriConf, null, 2) + '\n');

    // Update Cargo.lock - rewrite the root package version directly (like
    // `cargo set-version`), falling back to `cargo build` only when the root
    // package entry cannot be found, and verify the result either way.
    log.info('Updating src-tauri/Cargo.lock...');
    let cargoLock = fs.readFileSync(paths.cargoLock, 'utf8');
    try {
      cargoLock = updateCargoLock(cargoLock, newVersion);
    } catch {
      log.warn('Root package entry not found in Cargo.lock; using cargo build fallback...');
      execSync('cargo build --quiet', {
        cwd: path.join(rootDir, 'src-tauri'),
        stdio: 'ignore'
      });
      cargoLock = fs.readFileSync(paths.cargoLock, 'utf8');
    }
    fs.writeFileSync(paths.cargoLock, cargoLock);
    if (parseCargoLockVersion(cargoLock) !== newVersion) {
      throw new Error(
        `Cargo.lock root package version is ${parseCargoLockVersion(cargoLock)}, expected ${newVersion}`
      );
    }

    // Update CHANGELOG.md
    if (!skipChangelog) {
      log.info('Updating CHANGELOG.md...');
      const today = new Date().toISOString().split('T')[0];
      const changelog = fs.readFileSync(paths.changelog, 'utf8');
      const updated = updateChangelog(
        changelog,
        currentVersion,
        newVersion,
        today,
        bumpType,
        skipChangelog
      );
      fs.writeFileSync(paths.changelog, updated);
      log.warn('! Please update CHANGELOG.md with actual changes before committing');
    }

    // Create git commit
    if (!noCommit) {
      log.info('Creating git commit...');
      execSync('git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json');
      if (!skipChangelog) {
        execSync('git add CHANGELOG.md');
      }
      execSync(`git commit -m "chore: bump version to ${newVersion}"`);
      log.success(`[OK] Version bumped to ${newVersion} and committed`);
      log.warn('Don\'t forget to:');
      console.log('  1. Update CHANGELOG.md with actual changes');
      console.log('  2. Run: git commit --amend (if needed)');
      console.log(`  3. Create a git tag: git tag v${newVersion}`);
      console.log('  4. Push changes: git push && git push --tags');
    } else {
      log.success(`[OK] Version bumped to ${newVersion}`);
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