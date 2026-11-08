// RFB KeyEvent uses X11 keysyms. Printable Latin-1 keys use their own
// value, while the remaining Unicode characters use the X11 Unicode range.
const specialKeys = new Map([
  ['Backspace', 0xff08],
  ['Tab', 0xff09],
  ['Enter', 0xff0d],
  ['Pause', 0xff13],
  ['ScrollLock', 0xff14],
  ['Escape', 0xff1b],
  ['Home', 0xff50],
  ['ArrowLeft', 0xff51],
  ['ArrowUp', 0xff52],
  ['ArrowRight', 0xff53],
  ['ArrowDown', 0xff54],
  ['PageUp', 0xff55],
  ['PageDown', 0xff56],
  ['End', 0xff57],
  ['PrintScreen', 0xff61],
  ['Insert', 0xff63],
  ['ContextMenu', 0xff67],
  ['NumLock', 0xff7f],
  ['CapsLock', 0xffe5],
  ['AltGraph', 0xfe03],
  ['Delete', 0xffff],
]);

const modifiers = new Map([
  ['Shift', 0xffe1],
  ['Control', 0xffe3],
  ['Alt', 0xffe9],
  ['Meta', 0xffeb], // Super_L / Super_R.
]);

const modifierKeysyms = new Set(
  [...modifiers.values()].flatMap(keysym => [keysym, keysym + 1]),
);

export function isVncModifierKey(key: string): boolean {
  return modifiers.has(key) || key === 'AltGraph';
}

export function isVncModifierKeysym(keysym: number): boolean {
  return modifierKeysyms.has(keysym) || keysym === specialKeys.get('AltGraph');
}

export function vncKeysym(key: string, location: number): number | undefined {
  const modifier = modifiers.get(key);
  if (modifier !== undefined) return modifier + (location === 2 ? 1 : 0);
  if (key === 'Enter' && location === 3) return 0xff8d; // KP_Enter.
  const special = specialKeys.get(key);
  if (special !== undefined) return special;
  if (/^F(?:[1-9]|1\d|2[0-4])$/.test(key)) return 0xffbd + Number(key.slice(1));

  const codePoint = key.codePointAt(0);
  if (codePoint === undefined || key.length !== (codePoint > 0xffff ? 2 : 1)) return undefined;
  return codePoint <= 0xff ? codePoint : 0x01000000 + codePoint;
}
