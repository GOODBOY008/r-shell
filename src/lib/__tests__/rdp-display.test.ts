import { describe, expect, it } from 'vitest';
import { rdpConnectDisplay, rdpDisplaySize, rdpScaleFactor } from '../rdp-display';

describe('RDP display policy', () => {
  it('uses readable logical pixels on Retina and caps large windows without stretching', () => {
    expect(rdpDisplaySize(800, 450, 'fit', 2)).toEqual({ width: 800, height: 450, scaleFactor: 100 });
    expect(rdpDisplaySize(3840, 2160, 'fit', 2)).toEqual({ width: 1920, height: 1080, scaleFactor: 100 });
    expect(rdpDisplaySize(2046, 1290, 'fit', 2)).toEqual({ width: 1712, height: 1080, scaleFactor: 100 });
    expect(rdpDisplaySize(2560, 1080, 'fit', 2)).toEqual({ width: 1920, height: 810, scaleFactor: 100 });
  });
  it('opts into Retina pixels and matching Windows text scale', () => {
    expect(rdpDisplaySize(1280, 720, 'retina', 2)).toEqual({ width: 2560, height: 1440, scaleFactor: 200 });
    expect(rdpScaleFactor('retina', 1.5)).toBe(150);
    expect(rdpDisplaySize(9000, 6000, 'retina', 2)).toEqual({ width: 8192, height: 5461, scaleFactor: 200 });
  });
  it('keeps fixed desktops stable and rejects unmeasured sizes', () => {
    for (const resolution of ['1920x1080', '2560x1440']) expect(rdpDisplaySize(800, 450, resolution, 2)).toBeNull();
    expect(rdpDisplaySize(0, 10)).toBeNull();
    expect(rdpDisplaySize(Infinity, 10)).toBeNull();
    expect(rdpDisplaySize(801, 100)).toEqual({ width: 800, height: 200, scaleFactor: 100 });
    expect(rdpScaleFactor('retina', NaN)).toBe(100);
    expect(rdpScaleFactor('retina', 9)).toBe(500);
    expect(rdpConnectDisplay()).toEqual({ resolution: 'fit', desktop_scale_factor: 100 });
  });
});
