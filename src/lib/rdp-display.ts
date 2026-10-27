/** Saved "fit" values remain compatible with Balanced Auto. */
export type RdpResolution = 'fit' | 'retina' | '1024x768' | '1280x720' | '1920x1080' | '2560x1440';

export function rdpScaleFactor(resolution = 'fit', dpr = window.devicePixelRatio): number {
  return resolution === 'retina' && Number.isFinite(dpr)
    ? Math.round(Math.min(5, Math.max(1, dpr)) * 100)
    : 100;
}

/** Logical pixels by default; Retina explicitly opts into physical pixels. */
export function rdpDisplaySize(width: number, height: number, resolution = 'fit', dpr = window.devicePixelRatio) {
  if (!['fit', 'retina'].includes(resolution) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const scaleFactor = rdpScaleFactor(resolution, dpr);
  const density = scaleFactor / 100;
  const capWidth = resolution === 'retina' ? 8192 : 1920;
  const capHeight = resolution === 'retina' ? 8192 : 1080;
  const fit = Math.min(1, capWidth / (width * density), capHeight / (height * density));
  return {
    // MS-RDPEDISP requires an even width and dimensions in [200, 8192].
    width: Math.max(200, Math.floor(width * density * fit / 2) * 2),
    height: Math.max(200, Math.floor(height * density * fit)),
    scaleFactor,
  };
}

/** All connect paths use the same fallback and initial Windows text scaling. */
export function rdpConnectDisplay(resolution = 'fit') {
  return { resolution, desktop_scale_factor: rdpScaleFactor(resolution) };
}
