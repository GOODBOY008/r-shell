#!/usr/bin/env node

/**
 * Checks that en.json and zh-CN.json have the same set of keys.
 * Exits with code 1 if there are any missing or extra keys.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const localeDir = resolve(__dirname, '..', 'src', 'locales');

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

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

const en = loadJson(resolve(localeDir, 'en.json'));
const zh = loadJson(resolve(localeDir, 'zh-CN.json'));

const enKeys = new Set(flattenKeys(en));
const zhKeys = new Set(flattenKeys(zh));

const missing = [...enKeys].filter(k => !zhKeys.has(k));
const extra = [...zhKeys].filter(k => !enKeys.has(k));

if (missing.length > 0) {
  console.error(`Missing keys in zh-CN.json (${missing.length}):`);
  missing.forEach(k => console.error(`  - ${k}`));
}

if (extra.length > 0) {
  console.error(`Extra keys in zh-CN.json not in en.json (${extra.length}):`);
  extra.forEach(k => console.error(`  - ${k}`));
}

if (missing.length === 0 && extra.length === 0) {
  console.log(`✓ Key parity check passed (${enKeys.size} keys in both files).`);
  process.exit(0);
} else {
  console.error(`\nTotal: ${enKeys.size} keys in en.json, ${zhKeys.size} keys in zh-CN.json`);
  process.exit(1);
}
