#!/usr/bin/env node

/**
 * Checks that every locale file defines the same set of translation keys as
 * en.json (the source of truth).
 *
 * Plural keys are compared by their base key, not their suffix: i18next picks
 * the suffix from the language's CLDR plural categories, so English needs
 * `_one`/`_other` while Polish needs `_one`/`_few`/`_many`/`_other`. Requiring
 * identical suffixes across locales would make a correct Polish translation
 * fail. Instead each locale must cover exactly the categories its language
 * defines, which is what Intl.PluralRules reports.
 *
 * Exits with code 1 if any locale has missing, extra or incomplete keys.
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
  const rules = new Intl.PluralRules(locale);
  const categories = new Set(['other']);
  // Sample enough integers to hit every category of the languages we support.
  for (let n = 0; n <= 200; n++) categories.add(rules.select(n));
  return categories;
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

for (const file of localeFiles) {
  if (file === sourceFile) continue;
  const locale = basename(file, '.json');
  const index = indexKeys(flattenKeys(loadJson(resolve(localeDir, file))));
  const categories = pluralCategories(locale);

  const missing = [...sourceIndex.keys()].filter((k) => !index.has(k));
  const extra = [...index.keys()].filter((k) => !sourceIndex.has(k));

  // A plural key must provide every category the language actually uses.
  const incomplete = [];
  for (const [base, suffixes] of sourceIndex) {
    if (!suffixes.has(null) && index.has(base)) {
      const have = index.get(base);
      const want = [...categories].filter((c) => !have.has(c));
      if (want.length > 0) incomplete.push(`${base} (missing _${want.join(', _')})`);
    }
  }

  if (missing.length === 0 && extra.length === 0 && incomplete.length === 0) {
    console.log(`✓ ${file}: ${index.size} keys match ${sourceFile}`);
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
}

if (failed) {
  process.exit(1);
}

console.log(`✓ Key parity check passed (${sourceIndex.size} keys, ${localeFiles.length} locales).`);
process.exit(0);
