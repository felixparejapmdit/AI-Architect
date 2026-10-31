import { isWetZone } from "./buckets";
import { suggestMaterial, type Material } from "./materials";
import type { BucketId, ZoneType } from "./types";

/**
 * Design styles as coordinated finishes for the whole room. Each one maps to catalogue
 * materials, so a style is costed, scheduled and checked against the zone rules like any
 * hand-picked selection, and it changes only the surfaces, never the room.
 */
export interface StylePreset {
  id: string;
  name: string;
  blurb: string;
  materials: Partial<Record<BucketId, string>>;
}

export const STYLE_PRESETS: StylePreset[] = [
  { id: "modern-minimal", name: "Modern minimal", blurb: "Large porcelain, white walls, flush gypsum ceiling", materials: { floor: "porcelain-600x1200", walls: "anti-mold-paint", ceiling: "mr-gypsum-ceiling" } },
  { id: "warm-tropical", name: "Warm tropical", blurb: "Wood-look plank, fluted WPC walls, wood-grain linear ceiling", materials: { floor: "spc-plank", walls: "wpc-fluted-panel", ceiling: "aluminium-linear-ceiling" } },
  { id: "japandi", name: "Japandi", blurb: "Light wood-look floor, soft painted walls, wood-grain ceiling", materials: { floor: "spc-plank", walls: "anti-mold-paint", ceiling: "aluminium-linear-ceiling" } },
  { id: "industrial", name: "Industrial", blurb: "PU-cement floor, microcement walls, fibre-cement ceiling", materials: { floor: "pu-cement-screed", walls: "microcement", ceiling: "fiber-cement-ceiling" } },
  { id: "luxe-stone", name: "Luxe stone", blurb: "Sintered stone floor and walls, gypsum ceiling", materials: { floor: "sintered-stone-12", walls: "sintered-stone-12", ceiling: "mr-gypsum-ceiling" } },
];

/**
 * The material a style puts on a surface in this zone: the preset's choice when the zone allows
 * it, otherwise the zone-safe equivalent of the same texture family (e.g. a wet-rated tile in a
 * bathroom instead of a wood-look plank).
 */
export function styleMaterialFor(preset: StylePreset, bucket: BucketId, zone: ZoneType, library: Material[]): string | null {
  const id = preset.materials[bucket];
  if (!id) return null;
  const m = library.find((x) => x.id === id);
  if (!m) return null;
  const allowed = m.buckets.includes(bucket) && (!isWetZone(zone) || m.wetOk) && (m.zones === "any" || m.zones.includes(zone));
  if (allowed) return id;
  const analysis = { family: m.family, confidence: 1, swatch: "#808080", tone: "mid", warmth: "neutral", features: {} } as const;
  return suggestMaterial(bucket, zone, analysis, library).materialId;
}
