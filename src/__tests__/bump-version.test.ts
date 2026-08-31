import { describe, expect, it } from 'vitest';
import {
  parseVersion,
  isPrereleaseVersion,
  baseVersion,
  nextPrereleaseTag,
  computeNextVersion,
  updateChangelog,
  insertSection,
  STABLE_BUMP_TYPES,
  BUMP_TYPES,
  parsePackageJsonVersion,
  parseCargoTomlVersion,
  parseCargoLockVersion,
  parseTauriConfVersion,
  collectFileVersions,
  findVersionDrift,
  updateCargoLock,
  parseReleaseTag,
  verifyTagAgainstFiles,
} from '../lib/version-bump.mjs';

const SYNCED_FILES = {
  packageJson: JSON.stringify({ name: 'r-shell', version: '2.7.0' }),
  cargoToml: '[package]\nname = "r-shell"\nversion = "2.7.0"\n',
  cargoLock: 'version = 4\n\n[[package]]\nname = "r-shell"\nversion = "2.7.0"\ndependencies = []\n',
  tauriConf: JSON.stringify({ productName: 'r-shell', version: '2.7.0' }),
};

describe('parseVersion', () => {
  it('parses a stable semver', () => {
    expect(parseVersion('2.7.0')).toEqual({ major: 2, minor: 7, patch: 0, prerelease: null, build: null });
  });

  it('parses a prerelease suffix', () => {
    expect(parseVersion('2.8.0-beta.1')).toEqual({ major: 2, minor: 8, patch: 0, prerelease: 'beta.1', build: null });
    expect(parseVersion('2.8.0-rc.2')).toEqual({ major: 2, minor: 8, patch: 0, prerelease: 'rc.2', build: null });
  });

  it('parses build metadata and keeps it separate', () => {
    expect(parseVersion('1.2.3+build.5')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null, build: 'build.5' });
    expect(parseVersion('2.8.0-rc.1+build.7')).toEqual({ major: 2, minor: 8, patch: 0, prerelease: 'rc.1', build: 'build.7' });
  });

  it('rejects malformed versions', () => {
    expect(() => parseVersion('2.7')).toThrow('Invalid version string');
    expect(() => parseVersion('2.7.0.1')).toThrow('Invalid version string');
    expect(() => parseVersion('v2.7.0')).toThrow('Invalid version string');
    expect(() => parseVersion('2.7.0-beta..1')).toThrow('Invalid version string');
    expect(() => parseVersion('2.7.0+build..1')).toThrow('Invalid version string');
    expect(() => parseVersion('')).toThrow('Invalid version string');
  });

  it('trims surrounding whitespace', () => {
    expect(parseVersion(' 2.7.0 ').major).toBe(2);
  });
});

describe('isPrereleaseVersion', () => {
  it('distinguishes stable from prerelease', () => {
    expect(isPrereleaseVersion('2.8.0')).toBe(false);
    expect(isPrereleaseVersion('2.8.0-beta.1')).toBe(true);
    expect(isPrereleaseVersion('2.8.0-rc.9')).toBe(true);
    expect(isPrereleaseVersion('2.8.0+build.1')).toBe(false);
  });
});

describe('baseVersion', () => {
  it('strips the prerelease suffix', () => {
    expect(baseVersion(parseVersion('2.8.0-beta.3'))).toBe('2.8.0');
    expect(baseVersion(parseVersion('2.7.0'))).toBe('2.7.0');
  });
});

describe('nextPrereleaseTag', () => {
  it('defaults to beta', () => {
    expect(nextPrereleaseTag(null, undefined)).toBe('beta.1');
    expect(nextPrereleaseTag(null, 'rc')).toBe('rc.1');
  });

  it('increments within the same identifier', () => {
    expect(nextPrereleaseTag('beta.1', 'beta')).toBe('beta.2');
    expect(nextPrereleaseTag('rc.4', 'rc')).toBe('rc.5');
  });

  it('starts at .1 when switching identifiers', () => {
    expect(nextPrereleaseTag('beta.3', 'rc')).toBe('rc.1');
    expect(nextPrereleaseTag('rc.1', undefined)).toBe('beta.1');
  });

  it('restarts at .1 for a non-numeric or zero suffix', () => {
    expect(nextPrereleaseTag('beta.0', 'beta')).toBe('beta.1');
    expect(nextPrereleaseTag('beta', 'beta')).toBe('beta.1');
    expect(nextPrereleaseTag('beta.next', 'beta')).toBe('beta.1');
  });
});

describe('computeNextVersion', () => {
  it.each([
    // stable bumps stay stable
    ['2.7.0', 'patch', undefined, '2.7.1'],
    ['2.7.0', 'minor', undefined, '2.8.0'],
    ['2.7.0', 'major', undefined, '3.0.0'],
    // stable bumps from a prerelease drop the suffix
    ['2.8.0-beta.3', 'patch', undefined, '2.8.1'],
    ['2.8.0-beta.3', 'minor', undefined, '2.9.0'],
    ['2.8.0-beta.3', 'major', undefined, '3.0.0'],
    // prerelease from stable opens the next minor line
    ['2.7.0', 'prerelease', undefined, '2.8.0-beta.1'],
    ['2.7.0', 'prerelease', 'rc', '2.8.0-rc.1'],
    // prerelease iteration within the same line
    ['2.8.0-beta.1', 'prerelease', 'beta', '2.8.0-beta.2'],
    ['2.8.0-beta.4', 'prerelease', undefined, '2.8.0-beta.5'],
    ['2.8.0-rc.1', 'prerelease', 'rc', '2.8.0-rc.2'],
    // prerelease with a different identifier switches lines at .1
    ['2.8.0-beta.3', 'prerelease', 'rc', '2.8.0-rc.1'],
    ['2.8.0-beta.3', 'prerelease', 'alpha', '2.8.0-alpha.1'],
    // stable finalizes a prerelease to its base version
    ['2.8.0-beta.3', 'stable', undefined, '2.8.0'],
    ['2.8.0-rc.1', 'stable', undefined, '2.8.0'],
    // build metadata is dropped by any bump
    ['1.2.3+build.5', 'patch', undefined, '1.2.4'],
    ['2.8.0-beta.1+build.5', 'stable', undefined, '2.8.0'],
  ])('%s %s -> %s', (current, bumpType, identifier, expected) => {
    expect(computeNextVersion(current, bumpType, identifier)).toBe(expected);
  });

  it('rejects stable from an already-stable version', () => {
    expect(() => computeNextVersion('2.7.0', 'stable', undefined)).toThrow('already stable');
  });

  it('rejects unknown bump types', () => {
    expect(() => computeNextVersion('2.7.0', 'banana')).toThrow('Unknown bump type');
  });
});

describe('bump type sets', () => {
  it('defines the expected stable bump types', () => {
    expect(STABLE_BUMP_TYPES).toEqual(['major', 'minor', 'patch']);
  });

  it('BUMP_TYPES contains every supported type', () => {
    expect(BUMP_TYPES).toEqual(['major', 'minor', 'patch', 'prerelease', 'stable']);
  });
});

describe('version file readers', () => {
  it('reads package.json', () => {
    expect(parsePackageJsonVersion('{"version": "2.7.0"}')).toBe('2.7.0');
    expect(() => parsePackageJsonVersion('{}')).toThrow('no valid "version"');
  });

  it('reads Cargo.toml', () => {
    expect(parseCargoTomlVersion('[package]\nversion = "2.8.0-beta.1"\n')).toBe('2.8.0-beta.1');
    expect(() => parseCargoTomlVersion('[package]\nname = "x"\n')).toThrow('no "version = ..."');
  });

  it('reads the root r-shell entry of Cargo.lock, not dependency entries', () => {
    const lock = '[[package]]\nname = "adler2"\nversion = "2.0.1"\n\n[[package]]\nname = "r-shell"\nversion = "2.7.0"\n';
    expect(parseCargoLockVersion(lock)).toBe('2.7.0');
    expect(() => parseCargoLockVersion('[[package]]\nname = "adler2"\nversion = "2.0.1"\n')).toThrow('root "r-shell"');
  });

  it('reads tauri.conf.json', () => {
    expect(parseTauriConfVersion('{"productName": "r-shell", "version": "2.7.0"}')).toBe('2.7.0');
    expect(() => parseTauriConfVersion('{"version": ""}')).toThrow('no valid "version"');
  });
});

describe('collectFileVersions / findVersionDrift', () => {
  it('collects all four versions', () => {
    expect(collectFileVersions(SYNCED_FILES)).toEqual({
      'package.json': '2.7.0',
      'src-tauri/Cargo.toml': '2.7.0',
      'src-tauri/Cargo.lock': '2.7.0',
      'src-tauri/tauri.conf.json': '2.7.0',
    });
  });

  it('reports no drift when everything agrees', () => {
    expect(findVersionDrift(collectFileVersions(SYNCED_FILES))).toEqual([]);
  });

  it('reports every file that drifted from package.json', () => {
    const drifted = {
      ...SYNCED_FILES,
      cargoToml: '[package]\nversion = "2.7.1"\n',
      tauriConf: JSON.stringify({ version: '2.8.0' }),
    };
    expect(findVersionDrift(collectFileVersions(drifted))).toEqual([
      { file: 'src-tauri/Cargo.toml', version: '2.7.1' },
      { file: 'src-tauri/tauri.conf.json', version: '2.8.0' },
    ]);
  });
});

describe('updateCargoLock', () => {
  it('rewrites only the root package version', () => {
    const lock = '[[package]]\nname = "adler2"\nversion = "2.0.1"\n\n[[package]]\nname = "r-shell"\nversion = "2.7.0"\n';
    const updated = updateCargoLock(lock, '2.8.0-beta.1');
    expect(updated).toContain('name = "r-shell"\nversion = "2.8.0-beta.1"');
    expect(updated).toContain('name = "adler2"\nversion = "2.0.1"');
  });

  it('throws when the root package entry is missing', () => {
    expect(() => updateCargoLock('[[package]]\nname = "adler2"\nversion = "2.0.1"\n', '2.8.0')).toThrow(
      'not found'
    );
  });
});

describe('insertSection', () => {
  it('inserts after the Unreleased section', () => {
    const changelog = `# Changelog

## [Unreleased]

### Added

- _draft_

## [2.7.0] - 2026-08-08
`;
    const out = insertSection(changelog, '2.8.0', '2026-08-11');
    expect(out).toContain('## [2.8.0] - 2026-08-11');
    expect(out.indexOf('## [2.8.0]')).toBeLessThan(out.indexOf('## [2.7.0]'));
    expect(out.indexOf('## [Unreleased]')).toBeLessThan(out.indexOf('## [2.8.0]'));
  });

  it('handles a multi-line Unreleased section', () => {
    const changelog = `# Changelog

## [Unreleased]

### Added

- one
- two

## [2.7.0] - 2026-08-08
`;
    const out = insertSection(changelog, '2.8.0', '2026-08-11');
    expect(out.indexOf('## [2.8.0]')).toBeGreaterThan(out.indexOf('- two'));
    expect(out.indexOf('## [2.8.0]')).toBeLessThan(out.indexOf('## [2.7.0]'));
  });

  it('inserts at the top when there is no Unreleased section', () => {
    const changelog = `# Changelog

## [2.7.0] - 2026-08-08
`;
    const out = insertSection(changelog, '2.8.0', '2026-08-11');
    expect(out.indexOf('## [2.8.0]')).toBeLessThan(out.indexOf('## [2.7.0]'));
    expect(out).toContain('## [2.7.0] - 2026-08-08');
  });

  it('appends when the changelog has no sections at all', () => {
    const out = insertSection('# Changelog\n\nintro text\n', '2.8.0', '2026-08-11');
    expect(out).toContain('## [2.8.0] - 2026-08-11');
    expect(out.indexOf('## [2.8.0]')).toBeGreaterThan(out.indexOf('intro text'));
  });

  it('appends after an Unreleased section at the end of the file', () => {
    const changelog = `# Changelog

## [Unreleased]

### Added

- _draft_
`;
    const out = insertSection(changelog, '2.8.0', '2026-08-11');
    expect(out.indexOf('## [2.8.0]')).toBeGreaterThan(out.indexOf('- _draft_'));
  });
});

describe('updateChangelog', () => {
  const FIXTURE = `# Changelog

## [Unreleased]

### Added

- _draft_

## [2.7.0] - 2026-08-08

### Added

- released feature
`;

  it('inserts a fresh section for stable bumps', () => {
    const out = updateChangelog(FIXTURE, '2.7.0', '2.8.0', '2026-08-11', 'minor', false);
    expect(out).toContain('## [2.8.0] - 2026-08-11');
    expect(out).toContain('## [2.7.0] - 2026-08-08');
    expect(out.indexOf('## [2.8.0]')).toBeLessThan(out.indexOf('## [2.7.0]'));
  });

  it('inserts a section even when the changelog has no Unreleased section', () => {
    const noUnreleased = `# Changelog

## [2.7.0] - 2026-08-08

### Added

- released feature
`;
    const out = updateChangelog(noUnreleased, '2.7.0', '2.8.0', '2026-08-11', 'minor', false);
    expect(out).toContain('## [2.8.0] - 2026-08-11');
    expect(out.indexOf('## [2.8.0]')).toBeLessThan(out.indexOf('## [2.7.0]'));
  });

  it('renames the base section when a prerelease line opens from a draft', () => {
    const drafted = `# Changelog

## [Unreleased]

### Added

- _draft_

## [2.8.0] - 2026-08-11

### Added

- drafted notes

## [2.7.0] - 2026-08-08
`;
    const out = updateChangelog(drafted, '2.7.0', '2.8.0-beta.1', '2026-08-11', 'prerelease', false);
    expect(out).toContain('## [2.8.0-beta.1] - 2026-08-11');
    expect(out).not.toContain('## [2.8.0] - 2026-08-11');
    expect(out).toContain('drafted notes');
  });

  it('renames the current prerelease section when iterating', () => {
    const prereleased = FIXTURE + `## [2.8.0-beta.1] - 2026-08-11

### Added

- beta feature
`;
    const out = updateChangelog(prereleased, '2.8.0-beta.1', '2.8.0-beta.2', '2026-08-12', 'prerelease', false);
    expect(out).toContain('## [2.8.0-beta.2] - 2026-08-12');
    expect(out).not.toContain('## [2.8.0-beta.1] - 2026-08-11');
    expect(out).toContain('beta feature');
    expect(out).toContain('## [2.7.0] - 2026-08-08');
  });

  it('renames the prerelease section to its base on finalize', () => {
    const prereleased = FIXTURE + `## [2.8.0-beta.3] - 2026-08-11

### Added

- rc feature
`;
    const out = updateChangelog(prereleased, '2.8.0-beta.3', '2.8.0', '2026-08-12', 'stable', false);
    expect(out).toContain('## [2.8.0] - 2026-08-12');
    expect(out).not.toContain('## [2.8.0-beta.3]');
    expect(out).toContain('rc feature');
  });

  it('renames a heading without duplicating the date suffix', () => {
    const prereleased = FIXTURE + `## [2.8.0-beta.1] - 2026-08-11

### Added

- beta feature
`;
    const out = updateChangelog(prereleased, '2.8.0-beta.1', '2.8.0-beta.2', '2026-08-12', 'prerelease', false);
    expect(out).toMatch(/^## \[2\.8\.0-beta\.2\] - 2026-08-12$/m);
    expect(out).not.toMatch(/## \[2\.8\.0-beta\.2\] - 2026-08-12 - /);
  });

  it('renames a heading with no date suffix cleanly', () => {
    const bare = `# Changelog

## [2.8.0-beta.1]

### Added

- beta feature
`;
    const out = updateChangelog(bare, '2.8.0-beta.1', '2.8.0', '2026-08-12', 'stable', false);
    expect(out).toMatch(/^## \[2\.8\.0\] - 2026-08-12$/m);
  });

  it('does not duplicate a section that already exists', () => {
    const withSection = FIXTURE + `## [2.8.0-beta.1] - 2026-08-11
`;
    const out = updateChangelog(withSection, '2.8.0-beta.1', '2.8.0-beta.1', '2026-08-11', 'prerelease', false);
    expect(out.match(/## \[2\.8\.0-beta\.1\]/g)).toHaveLength(1);
  });

  it('respects skipChangelog', () => {
    expect(updateChangelog(FIXTURE, '2.7.0', '2.8.0', '2026-08-11', 'minor', true)).toBe(FIXTURE);
  });
});

describe('verify-release-tag (parseReleaseTag)', () => {
  it('accepts stable tags', () => {
    expect(parseReleaseTag('v2.8.0')).toEqual({ ok: true, tag: 'v2.8.0', version: '2.8.0' });
  });

  it('accepts prerelease tags', () => {
    expect(parseReleaseTag('v2.8.0-beta.1')).toEqual({ ok: true, tag: 'v2.8.0-beta.1', version: '2.8.0-beta.1' });
    expect(parseReleaseTag('v2.8.0-rc.2')).toEqual({ ok: true, tag: 'v2.8.0-rc.2', version: '2.8.0-rc.2' });
  });

  it('rejects malformed tags', () => {
    expect(parseReleaseTag('2.8.0').ok).toBe(false);
    expect(parseReleaseTag('v2.8').ok).toBe(false);
    expect(parseReleaseTag('v2.8.0.1').ok).toBe(false);
    expect(parseReleaseTag('v2.8.0+meta').ok).toBe(false);
    expect(parseReleaseTag('').ok).toBe(false);
    expect(parseReleaseTag('v2.8.0-').ok).toBe(false);
  });
});

describe('verify-release-tag (verifyTagAgainstFiles)', () => {
  it('passes when the tag matches every version file', () => {
    const result = verifyTagAgainstFiles('v2.7.0', SYNCED_FILES);
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
  });

  it('reports every mismatched file for a prerelease tag', () => {
    const result = verifyTagAgainstFiles('v2.8.0-beta.1', SYNCED_FILES);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toHaveLength(4);
    expect(result.mismatches[0].file).toBe('package.json');
    expect(result.mismatches[0].expectedTagVersion).toBe('2.8.0-beta.1');
    expect(result.mismatches[0].fileVersion).toBe('2.7.0');
  });

  it('rejects a malformed tag before reading versions', () => {
    const result = verifyTagAgainstFiles('not-a-tag', SYNCED_FILES);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([]);
    expect(result.error).toContain('Invalid release tag');
  });
});
