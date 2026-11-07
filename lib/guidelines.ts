import type { BucketId, ZoneType } from "./types";
import { isWetZone, sceneOf } from "./buckets";
import type { Material } from "./materials";

export interface GuidelineGroup {
  title: string;
  items: string[];
}

const GENERAL: string[] = [
  "Pre-construction soil termite treatment by a licensed pest control operator, with a written warranty, before any floor finish goes down.",
  "Test concrete slab moisture before any resilient, timber-look or adhesive-bonded finish (ASTM F2170 in-situ RH ≤75%). New slabs in the rainy season can take 60+ days to dry.",
  "Store finishes indoors, off the ground and covered; cartons left on site absorb humidity and swell.",
  "Seal all wall and ceiling penetrations around AC lines; condensation dripping into voids is the leading cause of hidden mould.",
];

const WET: string[] = [
  "Wet zones: continuous waterproofing membrane under all tiling, upturned ≥150 mm at walls and 1800 mm in shower areas, flood-tested 24 h.",
  "Wet zones: 100% solids epoxy grout is mandatory. Cementitious grout will grow black mould within months in Philippine humidity.",
  "Provide mechanical exhaust ducted to outside air in every bathroom and kitchen.",
];

const FLOOR_CONCRETE: string =
  "Do not install click-lock floating floors directly over bare concrete. Air-conditioned rooms over warm slabs condense moisture underneath; lay a 0.2 mm PE vapour barrier with taped 200 mm laps or use glue-down products.";

const EXTERIOR: string[] = [
  "Schedule external works for the dry season where possible; paint, sealants and screeds need several rain-free hours to set.",
  "Fix roofing, cladding and their trims to the NSCP wind-zone requirements for the site; most failures in typhoons start at edges, eaves and ridges.",
  "Fall all paving at least 1.5% away from the building and keep finished ground at least 150 mm below the floor line, so rain never ponds against walls.",
  "Seal every penetration and the joint between frames and walls with exterior-grade polyurethane or MS-polymer sealant before the finish coat.",
  "Size gutters and downpipes for Philippine rainfall intensity and discharge them away from the foundation.",
];

export function buildGuidelines(zone: ZoneType, selections: Partial<Record<BucketId, Material | undefined>>): GuidelineGroup[] {
  if (sceneOf(zone) === "exterior") {
    const groups: GuidelineGroup[] = [{ title: "Tropical exterior practice", items: [...EXTERIOR] }];
    const seen = new Set<string>();
    for (const m of Object.values(selections)) {
      if (!m || seen.has(m.id) || !m.guidelines.length) continue;
      seen.add(m.id);
      groups.push({ title: m.name, items: m.guidelines });
    }
    return groups;
  }
  const groups: GuidelineGroup[] = [{ title: "General tropical practice", items: [...GENERAL] }];
  if (isWetZone(zone)) groups.push({ title: "Wet-zone requirements", items: [...WET] });

  const floor = selections.floor;
  if (floor && (floor.family === "wood" || floor.id === "spc-plank")) {
    groups[0].items.push(FLOOR_CONCRETE);
  }

  const seen = new Set<string>();
  for (const [bucket, m] of Object.entries(selections) as [BucketId, Material | undefined][]) {
    if (!m || seen.has(m.id) || !m.guidelines.length) continue;
    seen.add(m.id);
    groups.push({ title: `${m.name} (${bucket})`, items: m.guidelines });
  }
  return groups;
}
