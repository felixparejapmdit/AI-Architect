import type { BucketId, Scene, TextureAnalysis, ZoneType } from "./types";
import { sceneOf, zoneLabel } from "./buckets";
import type { Material } from "./materials";

const SURFACE_NOUN: Record<Scene, Record<BucketId, string>> = {
  interior: { floor: "floor", walls: "walls", ceiling: "ceiling", furniture: "furniture" },
  exterior: { floor: "ground paving", walls: "building facade", ceiling: "roof", furniture: "landscaping" },
};

function describeAnalysis(a: TextureAnalysis | undefined): string {
  if (!a) return "";
  const tone = a.tone === "mid" ? "" : a.tone;
  const warmth = a.warmth === "neutral" ? "" : a.warmth + "-toned";
  return [tone, warmth].filter(Boolean).join(" ");
}

export function surfacePrompt(bucket: BucketId, material: Material | undefined, analysis: TextureAnalysis | undefined, note: string, scene: Scene = "interior"): string {
  const parts = [describeAnalysis(analysis), material?.prompt ?? "", note.trim()].filter(Boolean);
  if (!parts.length) return "";
  return `${SURFACE_NOUN[scene][bucket]}: ${parts.join(", ")}`;
}

export function globalPrompt(zone: ZoneType, surfaceDescriptions: string[], extra: string): string {
  const exterior = sceneOf(zone) === "exterior";
  return [
    exterior
      ? `professional architectural exterior photograph of a ${zoneLabel(zone).toLowerCase()}, the same building with new finishes`
      : `professional architectural interior photograph of a ${zoneLabel(zone).toLowerCase()}`,
    ...surfaceDescriptions,
    exterior
      ? "realistic physically based materials, accurate scale and perspective, natural daylight, sharp focus, high detail"
      : "realistic physically based materials, accurate scale and perspective, soft natural daylight, sharp focus, high detail",
    extra.trim(),
  ]
    .filter(Boolean)
    .join(", ");
}
