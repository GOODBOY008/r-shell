export interface FontFamilyOption {
  value: string;
  label: string;
}

// Defaults and pickers share the exact CSS values so they cannot drift apart.
export const TERMINAL_FONT_FAMILIES: readonly FontFamilyOption[] = [
  { value: 'Menlo, Monaco, "Courier New", monospace', label: 'Menlo' },
  { value: "'JetBrains Mono', monospace", label: 'JetBrains Mono' },
  { value: "'Fira Code', monospace", label: 'Fira Code' },
  { value: "'Source Code Pro', monospace", label: 'Source Code Pro' },
  { value: 'Consolas, monospace', label: 'Consolas' },
  { value: 'Monaco, monospace', label: 'Monaco' },
  { value: "'Courier New', monospace", label: 'Courier New' },
];

export const EDITOR_FONT_FAMILIES: readonly FontFamilyOption[] = [
  { value: "'JetBrains Mono', 'Fira Code', Menlo, Monaco, 'Courier New', monospace", label: 'JetBrains Mono' },
  { value: "'Fira Code', Menlo, Monaco, 'Courier New', monospace", label: 'Fira Code' },
  { value: "'Source Code Pro', Menlo, Monaco, 'Courier New', monospace", label: 'Source Code Pro' },
  { value: "Menlo, Monaco, 'Courier New', monospace", label: 'Menlo' },
  ...TERMINAL_FONT_FAMILIES.slice(4),
];

/** Canonicalize equivalent preset spellings; preserve custom CSS stacks intact. */
export function normalizeFontFamily(value: string, options: readonly FontFamilyOption[]): string {
  const comparable = (family: string) => family.split(',')
    .map(name => name.trim().replace(/^(['"])(.*)\1$/, '$2').toLowerCase())
    .join(',');
  return options.find(option => comparable(option.value) === comparable(value))?.value ?? value;
}
