/**
 * Extracts a "dominant" color from the cover to tint the background.
 * Downscales the image to 24×24, ignores near-black/white pixels and groups by hue,
 * giving extra weight to saturation (vivid colors represent the cover better than grays).
 */
export type RGB = [number, number, number];

const cache = new Map<string, RGB | null>();

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

export async function dominantColor(url: string): Promise<RGB | null> {
  if (cache.has(url)) return cache.get(url)!;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.src = url;
  try {
    await img.decode();
    const size = 24;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);

    const buckets = new Map<number, { w: number; r: number; g: number; b: number }>();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const [h, s, l] = rgbToHsl(r, g, b);
      if (l < 0.08 || l > 0.92) continue;
      const key = s < 0.15 ? -1 : Math.round(h / 24);
      const w = 0.2 + s * s * 2;
      const acc = buckets.get(key) ?? { w: 0, r: 0, g: 0, b: 0 };
      acc.w += w;
      acc.r += r * w;
      acc.g += g * w;
      acc.b += b * w;
      buckets.set(key, acc);
    }
    let best: { w: number; r: number; g: number; b: number } | null = null;
    for (const v of buckets.values()) if (!best || v.w > best.w) best = v;
    const out: RGB | null = best ? [best.r / best.w, best.g / best.w, best.b / best.w] : null;
    cache.set(url, out);
    return out;
  } catch {
    // Image without CORS or network failure: the light stays brand purple only.
    cache.set(url, null);
    return null;
  }
}

/**
 * Cover color adjusted for the ambient light: medium lightness and restrained saturation.
 * CSS still mixes it with MercuryDev purple (which always dominates) at low opacity.
 */
export function toTint([r, g, b]: RGB): { base: string } {
  const [h, s] = rgbToHsl(r, g, b);
  const sat = Math.min(0.7, s);
  return { base: `hsl(${h.toFixed(0)} ${(sat * 100).toFixed(0)}% 52%)` };
}
