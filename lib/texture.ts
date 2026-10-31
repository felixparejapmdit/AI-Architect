import type { TextureAnalysis, TextureFamily } from "./types";

export interface PixelData {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/**
 * Heuristic material classifier for reference photos. It reads colour, contrast, gradient
 * energy, orientation coherence (wood grain) and axis-aligned periodicity (tile grids).
 * It is a suggestion engine: the result only pre-selects a catalogue item the user can change.
 */
export function analyzeTexture(px: PixelData): TextureAnalysis {
  const { data, width: w, height: h } = px;
  const n = w * h;
  const lum = new Float32Array(n);
  let r = 0, g = 0, b = 0, satSum = 0;
  for (let i = 0; i < n; i++) {
    const R = data[i * 4], G = data[i * 4 + 1], B = data[i * 4 + 2];
    r += R; g += G; b += B;
    const max = Math.max(R, G, B), min = Math.min(R, G, B);
    satSum += max === 0 ? 0 : (max - min) / max;
    lum[i] = (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255;
  }
  r /= n; g /= n; b /= n;
  const saturation = satSum / n;
  const meanLum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  let variance = 0;
  for (let i = 0; i < n; i++) variance += (lum[i] - meanLum) ** 2;
  const lumStd = Math.sqrt(variance / n);

  // Sobel gradients + structure tensor
  let energy = 0, jxx = 0, jyy = 0, jxy = 0;
  const colEdge = new Float32Array(w);
  const rowEdge = new Float32Array(h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = (yy: number, xx: number) => lum[yy * w + xx];
      const gx = p(y - 1, x + 1) + 2 * p(y, x + 1) + p(y + 1, x + 1) - p(y - 1, x - 1) - 2 * p(y, x - 1) - p(y + 1, x - 1);
      const gy = p(y + 1, x - 1) + 2 * p(y + 1, x) + p(y + 1, x + 1) - p(y - 1, x - 1) - 2 * p(y - 1, x) - p(y - 1, x + 1);
      energy += Math.hypot(gx, gy);
      jxx += gx * gx; jyy += gy * gy; jxy += gx * gy;
      colEdge[x] += Math.abs(gx);
      rowEdge[y] += Math.abs(gy);
    }
  }
  const inner = (w - 2) * (h - 2);
  const edgeDensity = energy / Math.max(1, inner);
  // 0 = isotropic, 1 = all gradients share one orientation (grain, brushed metal, flutes)
  const coherence = Math.sqrt((jxx - jyy) ** 2 + 4 * jxy * jxy) / Math.max(1e-6, jxx + jyy);
  const gridiness = (peakiness(colEdge) + peakiness(rowEdge)) / 2;

  const hue = rgbHue(r, g, b);
  const warm = (hue < 50 || hue > 330) && saturation > 0.12;
  const features = { meanLum, lumStd, saturation, edgeDensity, coherence, gridiness, hue };

  const scores: Record<TextureFamily, number> = {
    tile: gridiness * 1.6 + (saturation < 0.25 ? 0.1 : 0),
    wood: coherence * 1.4 + (warm ? 0.45 : 0) + (saturation > 0.18 && saturation < 0.6 ? 0.15 : 0),
    stone: (saturation < 0.15 ? 0.35 : 0) + (meanLum > 0.55 ? 0.25 : 0) + (edgeDensity > 0.08 && edgeDensity < 0.6 ? 0.3 : 0) + (lumStd > 0.06 ? 0.15 : 0),
    concrete: (saturation < 0.12 ? 0.4 : 0) + (meanLum > 0.3 && meanLum < 0.7 ? 0.25 : 0) + (lumStd < 0.08 ? 0.25 : 0) + (edgeDensity < 0.35 ? 0.1 : 0),
    plain: (lumStd < 0.035 ? 0.7 : 0) + (edgeDensity < 0.05 ? 0.5 : 0),
    fabric: (edgeDensity > 0.5 ? 0.45 : 0) + (coherence < 0.25 ? 0.2 : 0) + (saturation > 0.2 ? 0.15 : 0),
    metal: (saturation < 0.1 ? 0.2 : 0) + (coherence > 0.5 ? 0.3 : 0) + (lumStd > 0.12 ? 0.2 : 0) - (warm ? 0.3 : 0),
  };
  const ranked = (Object.entries(scores) as [TextureFamily, number][]).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  const confidence = Math.max(0.2, Math.min(0.95, best[1] / (best[1] + Math.max(0.05, second[1]))));

  return {
    family: best[0],
    confidence: Math.round(confidence * 100) / 100,
    swatch: "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join(""),
    tone: meanLum > 0.62 ? "light" : meanLum < 0.32 ? "dark" : "mid",
    warmth: warm ? "warm" : saturation < 0.08 ? "neutral" : hue > 170 && hue < 260 ? "cool" : "neutral",
    features,
  };
}

/**
 * Evens out the lighting of a reference photo in place: shadows, vignetting and light falloff
 * across the sample are divided out so IP-Adapter picks up the material's colour and texture,
 * not the light it was photographed in (the high-pass "texture equalization" used to prepare
 * albedo maps, as in ComfyUI-TextureAlchemy's Texture Equalizer). The illumination estimate is
 * the luminance blurred over `radius` (a fraction of the short side); detail smaller than that
 * (grain, veining, grout) is kept. One gain per pixel scales R, G and B alike, so hue and
 * saturation are preserved.
 *
 * The correction is adaptive: its strength follows how uneven that illumination field is, so an
 * evenly lit catalogue photo passes through untouched (large-scale patterns such as marble vein
 * clusters would otherwise be flattened) and a phone photo with a shadow or vignette is fixed.
 * Returns the strength applied, 0..1.
 */
export function equalizeLighting(px: PixelData, opts: { radius?: number } = {}): number {
  const { data } = px;
  const n = px.width * px.height;
  const { light, mean, spread } = illumination(px, opts.radius);
  const strength = Math.min(1, Math.max(0, (spread - SPREAD_EVEN) / (SPREAD_FULL - SPREAD_EVEN)));
  if (strength === 0) return 0;
  for (let i = 0; i < n; i++) {
    // Clamped so a deep shadow or a specular hot spot is softened rather than blown out.
    const gain = 1 + strength * (Math.min(1.8, Math.max(0.6, mean / Math.max(1, light[i]))) - 1);
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.min(255, Math.max(0, Math.round(data[i * 4 + c] * gain)));
  }
  return Math.round(strength * 100) / 100;
}

/** Illumination spread (p95 - p5) / mean at which equalization starts, and reaches full strength. */
const SPREAD_EVEN = 0.15;
const SPREAD_FULL = 0.5;

/** Low-frequency luminance (the light falling on the sample), its mean and its relative spread. */
export function illumination(px: PixelData, radius = 0.25): { light: Float32Array; mean: number; spread: number } {
  const { data, width: w, height: h } = px;
  const n = w * h;
  const lum = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) {
    lum[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
    mean += lum[i];
  }
  mean /= n;
  const r = Math.max(2, Math.round(radius * Math.min(w, h)));
  let light: Float32Array = lum;
  for (let pass = 0; pass < 3; pass++) light = boxBlur(light, w, h, r); // ≈ Gaussian
  const G = 24;
  const sample = Array.from({ length: G * G }, (_, k) => light[Math.floor((((k / G) | 0) + 0.5) * (h / G)) * w + Math.floor(((k % G) + 0.5) * (w / G))]).sort((a, b) => a - b);
  return { light, mean, spread: (sample[Math.floor(G * G * 0.95)] - sample[Math.floor(G * G * 0.05)]) / Math.max(1, mean) };
}

/** Separable box blur with clamped edges, O(pixels) regardless of radius. */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const norm = 1 / (2 * r + 1);
  const at = (i: number, max: number) => (i < 0 ? 0 : i > max ? max : i);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + at(k, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * norm;
      acc += src[row + at(x + r + 1, w - 1)] - src[row + at(x - r, w - 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[at(k, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc * norm;
      acc += tmp[at(y + r + 1, h - 1) * w + x] - tmp[at(y - r, h - 1) * w + x];
    }
  }
  return out;
}

/** How much a 1-D edge profile is dominated by sharp, repeated peaks (grout lines). */
function peakiness(profile: Float32Array): number {
  const v = Array.from(profile).slice(1, -1);
  if (v.length < 8) return 0;
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  if (mean <= 0) return 0;
  const peaks = v.filter((x, i) => x > mean * 2.2 && x >= (v[i - 1] ?? 0) && x >= (v[i + 1] ?? 0));
  if (peaks.length < 2 || peaks.length > v.length / 6) return 0;
  const share = peaks.reduce((s, x) => s + x, 0) / (mean * v.length);
  return Math.min(1, share * 2.5);
}

function rgbHue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
}
