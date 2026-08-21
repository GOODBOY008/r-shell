#!/usr/bin/env node

/**
 * Verify that a release tag matches the project's declared version across all
 * four version files. Runs in CI before any release build starts so a
 * mis-tagged release fails fast instead of shipping mismatched artifacts
 * (same pattern used by openusage's publish workflow and tauri-action's
 * version checks).
 *
 * Usage:
 *   node scripts/verify-release-tag.mjs v2.8.0
 *   node scripts/verify-release-tag.mjs v2.8.0-beta.1 --root /path/to/repo
 *
 * The tag may be passed as argv[2], or taken from the GITHUB_REF_NAME
 * environment variable when invoked from a GitHub Actions tag push.
 * Exit code 0 = tag matches every version file; 1 = mismatch or bad tag.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  parseVersion,
  collectFileVersions,
  findVersionDrift
} from './bump-version.mjs';

/**
 * Pure tag validation. Returns { ok, version?, error? }. Accepts any semver
 * `vX.Y.Z` or `vX.Y.Z-<prerelease>` tag (stable and tagged prereleases);
 * rejects build metadata and non-semver shapes.
 */
export function parseReleaseTag(tag) {
  const trimmed = String(tag || '').trim();
  const SEMVER_IDENTIFIER = '(?:[0-9A-Za-z-]+)(?:\\.[0-9A-Za-z-]+)*';
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
 * Returns { ok, mismatches: [{file, expectedTagVersion, fileVersion}] }.
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

function main() {
  const args = process.argv.slice(2);
  const tagArg = args.find((arg) => !arg.startsWith('--'));
  const rootFlag = args.find((arg) => arg.startsWith('--root='));
  const rootDir = rootFlag ? rootFlag.slice('--root='.length) : process.cwd();

  const tag = tagArg || process.env.GITHUB_REF_NAME;
  if (!tag) {
    console.error('Error: no tag given. Pass it as an argument or set GITHUB_REF_NAME.');
    process.exit(2);
  }

  const parsed = parseReleaseTag(tag);
  if (!parsed.ok) {
    console.error(`Error: ${parsed.error}`);
    process.exit(1);
  }

  const read = (rel) => fs.readFileSync(path.join(rootDir, rel), 'utf8');
  let contents;
  try {
    contents = {
      packageJson: read('package.json'),
      cargoToml: read(path.join('src-tauri', 'Cargo.toml')),
      cargoLock: read(path.join('src-tauri', 'Cargo.lock')),
      tauriConf: read(path.join('src-tauri', 'tauri.conf.json'))
    };
  } catch (error) {
    console.error(`Error: cannot read project version files under ${rootDir}: ${error.message}`);
    process.exit(1);
  }

  const result = verifyTagAgainstFiles(tag, contents);
  if (!result.ok) {
    console.error(`Error: tag ${tag} does not match the project version:`);
    for (const m of result.mismatches) {
      console.error(`  - ${m.file}: ${m.fileVersion} (expected ${m.expectedTagVersion})`);
    }
    console.error('Fix the version files (or the tag) before releasing.');
    process.exit(1);
  }
  console.log(`OK: tag ${tag} matches package.json, Cargo.toml, Cargo.lock, tauri.conf.json`);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  main();
}