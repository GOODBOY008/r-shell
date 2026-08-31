/**
 * Version-bumping domain logic for r-shell (pure, framework-free ESM).
 *
 * Single source of truth shared by:
 *   - scripts/bump-version.mjs      (the CLI)
 *   - scripts/verify-release-tag.mjs (the CI/CLI tag validator)
 *   - src/__tests__/bump-version.test.ts (unit tests)
 *
 * It deliberately lives under src/lib so that Vitest transforms it inside
 * the project root: importing ESM from outside the root (scripts/) trips a
 * vite-node bug on Windows ("SyntaxError: Invalid or unexpected token").
 * It must stay free of Node built-ins and import.meta so both the browser
 * and the CLI can consume it without side effects.
 *
 * Tested by src/__tests__/bump-version.test.ts.
 */

/** Bump types that always land on a stable (non-prerelease) version. */
export const STABLE_BUMP_TYPES = ['major', 'minor', 'patch'];

/** Every supported bump type. */
export const BUMP_TYPES = [...STABLE_BUMP_TYPES, 'prerelease', 'stable'];

export const PRERELEASE_IDENTIFIER_RE = /^[0-9A-Za-z-]+$/;
export const DEFAULT_PRERELEASE_IDENTIFIER = 'beta';

// ---------------------------------------------------------------------------
// Pure version math
// ---------------------------------------------------------------------------

// A semver identifier: dot-separated, non-empty [0-9A-Za-z-] segments.
const SEMVER_IDENTIFIER = '(?:[0-9A-Za-z-]+)(?:\\.[0-9A-Za-z-]+)*';

/**
 * Parse a semver string into { major, minor, patch, prerelease, build }.
 * The prerelease component (everything after the first `-`) and the build
 * metadata (everything after the first `+`) are kept verbatim. Build metadata
 * is never carried over by a bump, per the SemVer spec.
 */
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
// Cargo.lock update (direct edit, with cargo fallback in the CLI)
// ---------------------------------------------------------------------------

/**
 * Rewrite the version of the root "r-shell" package inside Cargo.lock.
 * Editing the root package entry directly is what `cargo set-version` does
 * and avoids a full `cargo build` just to refresh a lockfile. Throws when the
 * root package entry cannot be found (the CLI falls back to `cargo build`).
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

/** True when the changelog has a "## [version]" heading. */
export function sectionExists(changelog, version) {
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
 * insertion never silently no-ops - the caller asserts the section exists.
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
// Release tag validation
// ---------------------------------------------------------------------------

/**
 * Pure tag validation. Returns { ok, version?, error? }. Accepts any semver
 * `vX.Y.Z` or `vX.Y.Z-<prerelease>` tag (stable and tagged prereleases);
 * rejects build metadata and non-semver shapes.
 */
export function parseReleaseTag(tag) {
  const trimmed = String(tag || '').trim();
  const tagPattern = new RegExp(`^v\\d+\\.\\d+\\.\\d+(-${SEMVER_IDENTIFIER})?$`);
  if (!tagPattern.test(trimmed)) {
    return {
      ok: false,
      error: `Invalid release tag '${trimmed}': expected vX.Y.Z or vX.Y.Z-<prerelease> (e.g. v2.8.0, v2.8.0-beta.1)`
    };
  }
  return { ok: true, tag: trimmed, version: trimmed.slice(1) };
}

/**
 * Pure sync check: does the tag version match every version file?
 * Returns { ok, mismatches: [{file, expectedTagVersion, fileVersion}], error? }.
 */
export function verifyTagAgainstFiles(tag, fileContents) {
  const parsed = parseReleaseTag(tag);
  if (!parsed.ok) {
    return { ok: false, mismatches: [], error: parsed.error };
  }
  const versions = collectFileVersions(fileContents);
  const mismatches = Object.entries(versions)
    .filter(([, version]) => version !== parsed.version)
    .map(([file, version]) => ({
      file,
      expectedTagVersion: parsed.version,
      fileVersion: version
    }));
  return { ok: mismatches.length === 0, mismatches };
}