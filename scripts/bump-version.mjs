#!/usr/bin/env node

/**
 * R-Shell Version Bump Script (Node.js version)
 * Cross-platform version bumping for Windows, macOS, and Linux.
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

export const BUMP_TYPES = [...STABLE_BUMP_TYPES, 'prerelease', 'stable'];

const PRERELEASE_IDENTIFIER_RE = /^[0-9A-Za-z-]+$/;
const DEFAULT_PRERELEASE_IDENTIFIER = 'beta';

// ---------------------------------------------------------------------------
// Pure version math (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Parse a semver string into { major, minor, patch, prerelease, build }.
 * The prerelease component (everything after the first `-`) and the build
 * metadata (everything after the first `+`) are kept verbatim. Build metadata
 * is never carried over by a bump, per the SemVer spec.
 */
// A semver identifier: dot-separated, non-empty [0-9A-Za-z-] segments.
const SEMVER_IDENTIFIER = '(?:[0-9A-Za-z-]+)(?:\\.[0-9A-Za-z-]+)*';

export function parseVersion(version) {
  const match = new RegExp(
    `^(\\d+)\\.(\\d+)\\.(\\d+)(?:-(${SEMVER_IDENTIFIER}))?(?:\\+(${SEMVER_IDENTIFIER}))?$`
  ).exec(String(version).trim());
  if (!match) {
    throw new Error(`Invalid version string: ${version}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || null,
    build: match[5] || null
  };
}

/** True when the version has a prerelease suffix ("2.8.0-beta.1" -> true). */
export function isPrereleaseVersion(version) {
  return parseVersion(version).prerelease !== null;
}

/** The core release line without any prerelease suffix: "2.8.0-beta.1" -> "2.8.0". */
export function baseVersion(parsed) {
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

/**
 * Advance a prerelease suffix within a line. Same identifier increments the
 * number ("beta.1" -> "beta.2"); a different identifier (or a fresh line)
 * starts at `.1` ("beta.3" + "rc" -> "rc.1").
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
// Version file readers (pure; take raw file content, return the version)
// ---------------------------------------------------------------------------

/** package.json -> "2.7.0" (throws on invalid JSON or missing version). */
export function parsePackageJsonVersion(content) {
  const pkg = JSON.parse(content);
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error('package.json has no valid "version" field');
  }
  return pkg.version;
}

/** Cargo.toml -> "2.7.0" (first `version = "..."` line). */
export function parseCargoTomlVersion(content) {
  const match = /^version\s*=\s*"([^"]+)"/m.exec(content);
  if (!match) {
    throw new Error('Cargo.toml has no "version = ..." line');
  }
  return match[1];
}

/** Cargo.lock -> version of the root package (the "r-shell" [[package]] entry). */
export function parseCargoLockVersion(content) {
  const match = /^name = "r-shell"\nversion = "([^"]+)"/m.exec(content);
  if (!match) {
    throw new Error('Cargo.lock has no root "r-shell" package entry');
  }
  return match[1];
}

/** tauri.conf.json -> "2.7.0". */
export function parseTauriConfVersion(content) {
  const conf = JSON.parse(content);
  if (typeof conf.version !== 'string' || conf.version === '') {
    throw new Error('tauri.conf.json has no valid "version" field');
  }
  return conf.version;
}

/**
 * Collect the versions declared by every version file. Keys are the file
 * names; the package.json version is the source of truth.
 */
export function collectFileVersions({ packageJson, cargoToml, cargoLock, tauriConf }) {
  return {
    'package.json': parsePackageJsonVersion(packageJson),
    'src-tauri/Cargo.toml': parseCargoTomlVersion(cargoToml),
    'src-tauri/Cargo.lock': parseCargoLockVersion(cargoLock),
    'src-tauri/tauri.conf.json': parseTauriConfVersion(tauriConf)
  };
}

/**
 * Return the files whose version differs from package.json, e.g.
 * [{ file: 'src-tauri/Cargo.toml', version: '2.7.1' }]. Empty when in sync.
 */
export function findVersionDrift(versions) {
  const reference = versions['package.json'];
  return Object.entries(versions)
    .filter(([file, version]) => file !== 'package.json' && version !== reference)
    .map(([file, version]) => ({ file, version }));
}

// ---------------------------------------------------------------------------
// Cargo.lock update (direct edit, with cargo fallback)
// ---------------------------------------------------------------------------

/**
 * Rewrite the version of the root "r-shell" package inside Cargo.lock.
 * Editing the root package entry directly is what `cargo set-version` does
 * and avoids a full `cargo build` just to refresh a lockfile. Throws when the
 * root package entry cannot be found (caller falls back to `cargo build`).
 */
export function updateCargoLock(content, newVersion) {
  const pattern = /^(name = "r-shell"\nversion = ")[^"]*(")/m;
  if (!pattern.test(content)) {
    throw new Error('Root "r-shell" package entry not found in Cargo.lock');
  }
  return content.replace(pattern, `$1${newVersion}$2`);
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
  // Replace the whole heading line (including any existing " - YYYY-MM-DD"
  // date suffix) so a rename never leaves a duplicated date behind.
  return changelog.replace(
    new RegExp(`^## \\[${escapeRegex(fromVersion)}\\][^\\n]*`, 'm'),
    `## [${toVersion}] - ${date}`
  );
}

function buildSection(version, date) {
  return `## [${version}] - ${date}

### Added

- _Add new features here_

### Changed

- _Add changes here_

### Fixed

- _Add bug fixes here_
`;
}

/**
 * Insert a fresh version section following the Keep a Changelog convention:
 * newest release on top, directly after the Unreleased section when one
 * exists. Falls back to inserting before the first released section (or
 * appending to the title block) when there is no Unreleased section, so the
 * insertion never silently no-ops — the caller asserts the section exists.
 */
export function insertSection(changelog, version, date) {
  const newSection = buildSection(version, date);

  const unreleasedMatch = /^## \[Unreleased\]/m.exec(changelog);
  if (unreleasedMatch) {
    const afterHeading = changelog.slice(unreleasedMatch.index + unreleasedMatch[0].length);
    const nextHeading = /^## /m.exec(afterHeading);
    const insertAt = nextHeading
      ? unreleasedMatch.index + unreleasedMatch[0].length + nextHeading.index
      : changelog.length;
    return spliceSection(changelog, insertAt, newSection);
  }

  const firstSection = /^## /m.exec(changelog);
  if (firstSection) {
    return spliceSection(changelog, firstSection.index, newSection);
  }

  return `${changelog.replace(/\s+$/, '')}\n\n${newSection}`;
}

/** Join `before` and `after` around a section with exactly one blank line each side. */
function spliceSection(changelog, insertAt, section) {
  const before = changelog.slice(0, insertAt).replace(/\s+$/, '');
  const after = changelog.slice(insertAt).replace(/^\n+/, '');
  return `${before}\n\n${section}${after ? `\n${after}` : ''}`;
}

/**
 * Add or update the CHANGELOG section for the bumped version.
 *
 * - Stable bumps (major/minor/patch) always insert a fresh section.
 * - Prerelease / stable-finalize bumps reuse the section for the same release
 *   line: rename an existing base ("## [2.8.0]") or current prerelease
 *   ("## [2.8.0-beta.2]") header so the notes drafted for one version carry
 *   over instead of accumulating duplicate sections.
 *
 * Throws when the new version's section is missing afterwards, so a broken
 * changelog format fails the bump instead of silently skipping the update.
 */
export function updateChangelog(changelog, currentVersion, newVersion, date, bumpType, skipChangelog) {
  if (skipChangelog) {
    return changelog;
  }

  if (STABLE_BUMP_TYPES.includes(bumpType)) {
    if (!sectionExists(changelog, newVersion)) {
      changelog = insertSection(changelog, newVersion, date);
    }
  } else {
    // prerelease / stable: reuse the same release line's section when possible.
    if (sectionExists(changelog, newVersion)) {
      return changelog;
    }

    const base = baseVersion(parseVersion(newVersion));
    if (sectionExists(changelog, base)) {
      changelog = renameSection(changelog, base, newVersion, date);
    } else {
      const curBase = baseVersion(parseVersion(currentVersion));
      if (curBase === base && sectionExists(changelog, currentVersion)) {
        changelog = renameSection(changelog, currentVersion, newVersion, date);
      } else {
        changelog = insertSection(changelog, newVersion, date);
      }
    }
  }

  if (!sectionExists(changelog, newVersion)) {
    throw new Error(
      `Failed to add a CHANGELOG section for ${newVersion}; the changelog format was not recognized.`
    );
  }
  return changelog;
}

// ---------------------------------------------------------------------------
// Preflight guardrails
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
    log.info('Dry run — no files were modified.');
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

    // Update Cargo.lock — rewrite the root package version directly (like
    // `cargo set-version`), falling back to `cargo build` only when the root
    // package entry cannot be found, and verify the result either way.
    log.info('Updating src-tauri/Cargo.lock...');
    let cargoLock = fs.readFileSync(paths.cargoLock, 'utf8');
    try {
      cargoLock = updateCargoLock(cargoLock, newVersion);
    } catch {
      log.warn('Root package entry not found in Cargo.lock; using cargo build fallback…');
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