/** Restore missing/invalid primitive preferences while retaining unknown keys. */
export function withSettingDefaults<T extends object>(value: unknown, defaults: T): T {
  const saved: Partial<T> = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
  const settings = { ...saved, ...defaults };
  for (const key of Object.keys(defaults) as Array<keyof T>) {
    const candidate = saved[key];
    if (typeof candidate !== typeof defaults[key]) continue;
    if (typeof candidate === 'number' && !Number.isFinite(candidate)) continue;
    if (typeof candidate === 'string') {
      // Empty strings are meaningful only for optional fields whose default is empty.
      const trimmed = candidate.trim();
      if (trimmed || defaults[key] === '') settings[key] = trimmed as T[keyof T];
    } else {
      settings[key] = candidate as T[keyof T];
    }
  }
  return settings;
}

export function numberSetting(value: number, fallback: number, min: number, max: number, integer = false): number {
  return Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value))
    ? value
    : fallback;
}

export function enumSetting<T extends string | number>(value: unknown, choices: readonly T[], fallback: T): T {
  return choices.includes(value as T) ? value as T : fallback;
}
