import { isWetZone, sceneOf } from "./buckets";
import { materialScene, suggestMaterial, type Material } from "./materials";
import type { BucketId, Scene, ZoneType } from "./types";

/**
 * Design styles as coordinated finishes for the whole room (or the whole exterior). Each one maps
 * to catalogue materials, so a style is costed, scheduled and checked against the zone rules like
 * any hand-picked selection, and it changes only the surfaces, never the building.
 */
export interface StylePreset {
  id: string;
  name: string;
  blurb: string;
  /** Interior presets leave this out. */
  scene?: Scene;
  materials: Partial<Record<BucketId, string>>;
}

export const STYLE_PRESETS: StylePreset[] = [
  { id: "modern-minimal", name: "Modern minimal", blurb: "Large porcelain, white walls, flush gypsum ceiling", materials: { floor: "porcelain-600x1200", walls: "anti-mold-paint", ceiling: "mr-gypsum-ceiling" } },
  { id: "warm-tropical", name: "Warm tropical", blurb: "Wood-look plank, fluted WPC walls, wood-grain linear ceiling", materials: { floor: "spc-plank", walls: "wpc-fluted-panel", ceiling: "aluminium-linear-ceiling" } },
  { id: "japandi", name: "Japandi", blurb: "Light wood-look floor, soft painted walls, wood-grain ceiling", materials: { floor: "spc-plank", walls: "anti-mold-paint", ceiling: "aluminium-linear-ceiling" } },
  { id: "industrial", name: "Industrial", blurb: "PU-cement floor, microcement walls, fibre-cement ceiling", materials: { floor: "pu-cement-screed", walls: "microcement", ceiling: "fiber-cement-ceiling" } },
  { id: "luxe-stone", name: "Luxe stone", blurb: "Sintered stone floor and walls, gypsum ceiling", materials: { floor: "sintered-stone-12", walls: "sintered-stone-12", ceiling: "mr-gypsum-ceiling" } },
  // Exterior
  { id: "ext-modern-tropical", name: "Modern tropical", scene: "exterior", blurb: "Wood-look fibre-cement siding, long-span roof, concrete pavers", materials: { floor: "pave-concrete-pavers", walls: "ext-fibre-cement-plank", ceiling: "roof-longspan" } },
  { id: "ext-clean-white", name: "Clean white", scene: "exterior", blurb: "White elastomeric render, long-span roof, washout paving", materials: { floor: "pave-washout", walls: "ext-elastomeric-paint", ceiling: "roof-longspan" } },
  { id: "ext-mediterranean", name: "Mediterranean", scene: "exterior", blurb: "Painted render, terracotta clay roof, granite pavers", materials: { floor: "pave-granite", walls: "ext-elastomeric-paint", ceiling: "roof-clay-tile" } },
  { id: "ext-stone-timber", name: "Stone & timber", scene: "exterior", blurb: "Stone veneer, stone-coated steel roof, granite pavers", materials: { floor: "pave-granite", walls: "ext-stone-veneer", ceiling: "roof-stone-coated" } },
];

/** The styles a project in this zone can apply: interior styles for rooms, exterior ones outside. */
export function stylesForZone(zone: ZoneType): StylePreset[] {
  const scene = sceneOf(zone);
  return STYLE_PRESETS.filter((p) => (p.scene ?? "interior") === scene);
}

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
  const allowed = materialScene(m) === sceneOf(zone) && m.buckets.includes(bucket) && (!isWetZone(zone) || m.wetOk) && (m.zones === "any" || m.zones.includes(zone));
  if (allowed) return id;
  const analysis = { family: m.family, confidence: 1, swatch: "#808080", tone: "mid", warmth: "neutral", features: {} } as const;
  return suggestMaterial(bucket, zone, analysis, library).materialId;
}
