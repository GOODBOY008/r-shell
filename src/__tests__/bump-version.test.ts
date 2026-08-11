import { describe, expect, it } from 'vitest';
import {
  parseVersion,
  baseVersion,
  nextPrereleaseTag,
  computeNextVersion,
  updateChangelog,
  STABLE_BUMP_TYPES,
} from '../../scripts/bump-version.mjs';

describe('parseVersion', () => {
  it('parses a stable semver', () => {
    expect(parseVersion('2.7.0')).toEqual({ major: 2, minor: 7, patch: 0, prerelease: null });
  });

  it('parses a prerelease suffix', () => {
    expect(parseVersion('2.8.0-beta.1')).toEqual({ major: 2, minor: 8, patch: 0, prerelease: 'beta.1' });
    expect(parseVersion('2.8.0-rc.2')).toEqual({ major: 2, minor: 8, patch: 0, prerelease: 'rc.2' });
  });

  it('rejects malformed versions', () => {
    expect(() => parseVersion('2.7')).toThrow('Invalid version string');
    expect(() => parseVersion('2.7.0.1')).toThrow('Invalid version string');
    expect(() => parseVersion('v2.7.0')).toThrow('Invalid version string');
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
    // stable finalizes a prerelease to its base version
    ['2.8.0-beta.3', 'stable', undefined, '2.8.0'],
    ['2.8.0-rc.1', 'stable', undefined, '2.8.0'],
  ])('%s %s -> %s', (current, bumpType, identifier, expected) => {
    expect(computeNextVersion(current, bumpType, identifier)).toBe(expected);
  });

  it('rejects stable from an already-stable version', () => {
    expect(() => computeNextVersion('2.7.0', 'stable', undefined)).toThrow('already stable');
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

  it('does not duplicate a section that already exists', () => {
    const withSection = FIXTURE + `## [2.8.0-beta.1] - 2026-08-11
`;
    const out = updateChangelog(withSection, '2.8.0-beta.1', '2.8.0-beta.1', '2026-08-11', 'prerelease', false);
    expect(out.match(/## \[2\.8\.0-beta\.1\]/g)).toHaveLength(1);
  });

  it('respects skipChangelog', () => {
    expect(updateChangelog(FIXTURE, '2.7.0', '2.8.0', '2026-08-11', 'minor', true)).toBe(FIXTURE);
  });

  it('defines the expected stable bump types', () => {
    expect(STABLE_BUMP_TYPES).toEqual(['major', 'minor', 'patch']);
  });
});
