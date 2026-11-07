import type { BucketId, LayerId, Scene, ZoneType } from "./types";

export const BUCKETS: BucketId[] = ["floor", "walls", "ceiling", "furniture"];
export const LAYERS: LayerId[] = [...BUCKETS, "protected"];

export interface LayerInfo {
  label: string;
  /** Overlay tint, rgb. */
  color: [number, number, number];
  /** SAM3 prompt: comma-separated concepts, each with ":N" max detections; detections are unioned. */
  samPrompt: string;
  threshold: number;
  shortcut: string;
}

/** Interior layers. Kept as the default export shape: colours and shortcuts are the same in both scenes. */
export const LAYER_INFO: Record<LayerId, LayerInfo> = {
  floor: { label: "Floor", color: [51, 102, 255], samPrompt: "floor:3", threshold: 0.4, shortcut: "1" },
  walls: { label: "Walls", color: [16, 185, 129], samPrompt: "wall:8", threshold: 0.35, shortcut: "2" },
  ceiling: { label: "Ceiling", color: [245, 158, 11], samPrompt: "ceiling:3", threshold: 0.4, shortcut: "3" },
  furniture: {
    label: "Furniture",
    color: [168, 85, 247],
    samPrompt: "sofa:4, armchair:4, chair:8, table:4, cabinet:6, bed:2, shelf:4",
    threshold: 0.45,
    shortcut: "4",
  },
  protected: {
    label: "Protected",
    color: [239, 68, 68],
    samPrompt: "window:10, door:6, column:6, beam:6",
    threshold: 0.4,
    shortcut: "0",
  },
};

/**
 * Exterior layers reuse the same four surface slots (and the whole render pipeline): ground /
 * paving, facade, roof and landscape. The sky, trees, vehicles and people are protected along with
 * openings, so only the building's finishes change.
 */
export const EXTERIOR_LAYER_INFO: Record<LayerId, LayerInfo> = {
  // Concepts measured with SAM3 on a house photo: "patio" also took porch railings, "lawn",
  // "grass" and "flower bed" took a whole bare yard, and "car" / "parked car" took the house itself.
  floor: { ...LAYER_INFO.floor, label: "Ground", samPrompt: "driveway:3, pavement:4, walkway:3, yard:3, ground:3", threshold: 0.4 },
  walls: { ...LAYER_INFO.walls, label: "Facade", samPrompt: "building facade:4, exterior wall:8, siding:4", threshold: 0.35 },
  ceiling: { ...LAYER_INFO.ceiling, label: "Roof", samPrompt: "roof:4", threshold: 0.4 },
  furniture: { ...LAYER_INFO.furniture, label: "Landscape", samPrompt: "shrub:6, bush:6, hedge:4", threshold: 0.4 },
  protected: {
    ...LAYER_INFO.protected,
    // "brick pillar" finds porch piers that "column" misses; "eaves" keeps the roofline and gable
    // trim, which a facade repaint otherwise reshapes.
    samPrompt: "window:12, door:6, sky:2, tree:8, vehicle:4, person:4, railing:4, column:6, brick pillar:6, eaves:4, fence:4",
    threshold: 0.4,
  },
};

export function layerInfo(layer: LayerId, scene: Scene = "interior"): LayerInfo {
  return (scene === "exterior" ? EXTERIOR_LAYER_INFO : LAYER_INFO)[layer];
}

/**
 * When detected masks overlap, the earlier layer wins. Protected structure always wins so
 * doors, windows and columns can never be repainted.
 */
export const LAYER_PRIORITY: LayerId[] = ["protected", "furniture", "ceiling", "floor", "walls"];

export const ZONES: { id: ZoneType; label: string; wet: boolean; scene: Scene }[] = [
  { id: "living", label: "Living room", wet: false, scene: "interior" },
  { id: "dining", label: "Dining", wet: false, scene: "interior" },
  { id: "bedroom", label: "Bedroom", wet: false, scene: "interior" },
  { id: "kitchen", label: "Kitchen", wet: true, scene: "interior" },
  { id: "bathroom", label: "Bathroom / T&B", wet: true, scene: "interior" },
  { id: "office", label: "Office", wet: false, scene: "interior" },
  { id: "parking", label: "Parking / garage", wet: false, scene: "interior" },
  { id: "commercial", label: "Commercial / retail", wet: false, scene: "interior" },
  { id: "outdoor-covered", label: "Covered outdoor / lanai", wet: true, scene: "interior" },
  // Exteriors take sun, rain and typhoons: every system must be weather-rated.
  { id: "house-exterior", label: "House exterior", wet: true, scene: "exterior" },
  { id: "commercial-exterior", label: "Commercial building exterior", wet: true, scene: "exterior" },
];

export function zoneLabel(zone: ZoneType): string {
  return ZONES.find((z) => z.id === zone)?.label ?? zone;
}

export function isWetZone(zone: ZoneType): boolean {
  return ZONES.find((z) => z.id === zone)?.wet ?? false;
}

export function sceneOf(zone: ZoneType): Scene {
  return ZONES.find((z) => z.id === zone)?.scene ?? "interior";
}

/** The zone a project switches to when the user picks a scene. */
export const DEFAULT_ZONE: Record<Scene, ZoneType> = { interior: "living", exterior: "house-exterior" };
