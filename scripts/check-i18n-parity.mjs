#!/usr/bin/env node

/**
 * Checks that every locale file — including en.json itself — defines the same
 * set of translation keys as en.json (the source of truth).
 *
 * Plural keys are compared by their base key, not their suffix: i18next picks
 * the suffix from the language's CLDR plural categories, so English needs
 * `_one`/`_other` while Polish needs `_one`/`_few`/`_many`/`_other`. Requiring
 * identical suffixes across locales would make a correct Polish translation
 * fail. Instead each locale must cover exactly the categories its language
 * declares, as reported by Intl.PluralRules' resolvedOptions().pluralCategories
 * (probing sample integers would miss categories that only appear far from
 * zero, e.g. French `_many` at 1,000,000).
 *
 * Non-plural source keys must stay non-plural: `t('common.cancel')` never
 * looks up `common.cancel_one`, so a locale replacing the plain key with
 * suffixed variants breaks the lookup at runtime.
 *
 * Exits with code 1 if any locale has missing, extra, misplaced or incomplete
 * keys.
 */

import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const localeDir = resolve(__dirname, '..', 'src', 'locales');

const SOURCE_LOCALE = 'en';
const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other'];

function flattenKeys(obj, prefix = '') {
  const keys = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      keys.push(...flattenKeys(value, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

/** Split `foo.bar_one` into { base: 'foo.bar', suffix: 'one' }. */
function splitPlural(key) {
  for (const suffix of PLURAL_SUFFIXES) {
    if (key.endsWith(`_${suffix}`)) {
      return { base: key.slice(0, -(suffix.length + 1)), suffix };
    }
  }
  return { base: key, suffix: null };
}

/** The plural categories i18next will look up for a language, per CLDR. */
function pluralCategories(locale) {
  return new Set(new Intl.PluralRules(locale).resolvedOptions().pluralCategories);
}

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

/** Map of base key -> Set of plural suffixes (null for non-plural keys). */
function indexKeys(keys) {
  const index = new Map();
  for (const key of keys) {
    const { base, suffix } = splitPlural(key);
    if (!index.has(base)) index.set(base, new Set());
    index.get(base).add(suffix);
  }
  return index;
}

const localeFiles = readdirSync(localeDir)
  .filter((f) => f.endsWith('.json'))
  .sort();

const sourceFile = `${SOURCE_LOCALE}.json`;
if (!localeFiles.includes(sourceFile)) {
  console.error(`Source locale ${sourceFile} not found in ${localeDir}`);
  process.exit(1);
}

const sourceIndex = indexKeys(flattenKeys(loadJson(resolve(localeDir, sourceFile))));
let failed = false;

// The source locale is validated in the same loop as the translations so the
// plural checks apply to it too (comparing it with itself is a no-op for
// missing/extra keys).
for (const file of localeFiles) {
  const locale = basename(file, '.json');
  const isSource = file === sourceFile;
  const index = isSource
    ? sourceIndex
    : indexKeys(flattenKeys(loadJson(resolve(localeDir, file))));
  const categories = pluralCategories(locale);

  const missing = [...sourceIndex.keys()].filter((k) => !index.has(k));
  const extra = [...index.keys()].filter((k) => !sourceIndex.has(k));

  // A plural key must provide every category the language declares, and a
  // non-plural key must stay non-plural — i18next looks up suffixed keys only
  // when the caller passes a count, so suffixed variants of a plain key would
  // be dead keys while the live lookup goes missing.
  const incomplete = [];
  const misplaced = [];
  for (const [base, suffixes] of sourceIndex) {
    if (!index.has(base)) continue;
    const have = index.get(base);
    if (suffixes.has(null) && suffixes.size === 1) {
      if (have.size > 1 || !have.has(null)) {
        const variants = [...have].filter((s) => s !== null).map((s) => `_${s}`);
        misplaced.push(`${base} (unexpected plural key(s): ${variants.join(', ')})`);
      }
    } else if (!suffixes.has(null)) {
      const want = [...categories].filter((c) => !have.has(c));
      if (want.length > 0) incomplete.push(`${base} (missing _${want.join(', _')})`);
    }
  }

  if (missing.length === 0 && extra.length === 0 && incomplete.length === 0 && misplaced.length === 0) {
    console.log(
      isSource
        ? `✓ ${file}: ${index.size} keys (source locale, plural forms verified)`
        : `✓ ${file}: ${index.size} keys match ${sourceFile}`,
    );
    continue;
  }

  failed = true;
  if (missing.length > 0) {
    console.error(`Missing keys in ${file} (${missing.length}):`);
    missing.forEach((k) => console.error(`  - ${k}`));
  }
  if (extra.length > 0) {
    console.error(`Extra keys in ${file} not in ${sourceFile} (${extra.length}):`);
    extra.forEach((k) => console.error(`  - ${k}`));
  }
  if (incomplete.length > 0) {
    console.error(`Incomplete plural forms in ${file} (${incomplete.length}):`);
    incomplete.forEach((k) => console.error(`  - ${k}`));
  }
  if (misplaced.length > 0) {
    console.error(`Keys pluralized in ${file} but non-plural in ${sourceFile} (${misplaced.length}):`);
    misplaced.forEach((k) => console.error(`  - ${k}`));
  }
}

if (failed) {
  process.exit(1);
}

console.log(`✓ Key parity check passed (${sourceIndex.size} keys, ${localeFiles.length} locales).`);
process.exit(0);
