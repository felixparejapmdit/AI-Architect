import { test } from "node:test";
import assert from "node:assert/strict";
import { EXTERIOR_LAYER_INFO, LAYER_INFO, LAYERS, layerInfo, sceneOf, ZONES } from "../lib/buckets";
import { computeBoq, measuredAreas } from "../lib/boq";
import { findMaterial, materialScene, materialsForZone, MATERIALS, suggestMaterial } from "../lib/materials";
import { STYLE_PRESETS, styleMaterialFor, stylesForZone } from "../lib/styles";
import { buildGuidelines } from "../lib/guidelines";
import { globalPrompt, surfacePrompt } from "../lib/prompting";
import { buildProgramme, proposalChecks } from "../lib/programme";
import { buildSegmentationGraph } from "../lib/workflow/segment";
import { renderProposalHtml } from "../lib/proposal";
import type { BucketId, Project, ProjectMeta, TextureAnalysis } from "../lib/types";

const fake = (family: TextureAnalysis["family"]): TextureAnalysis => ({ family, confidence: 0.8, swatch: "#cccccc", tone: "light", warmth: "neutral", features: {} });
const house: ProjectMeta = { client: "", location: "", preparedBy: "", zone: "house-exterior", floorArea: 30, ceilingHeight: 4, perimeter: 12, openingsPct: 25, furniturePieces: 3, roofArea: 100, landscapeArea: 15, contingencyPct: 10 };
const BUCKETS: BucketId[] = ["floor", "walls", "ceiling", "furniture"];

test("exterior zones and layers: ground, facade, roof, landscape; interior unchanged", () => {
  assert.equal(sceneOf("house-exterior"), "exterior");
  assert.equal(sceneOf("commercial-exterior"), "exterior");
  assert.equal(sceneOf("living"), "interior");
  assert.equal(sceneOf("outdoor-covered"), "interior", "a lanai is a covered room, not an exterior");
  assert.deepEqual(BUCKETS.map((b) => layerInfo(b, "exterior").label), ["Ground", "Facade", "Roof", "Landscape"]);
  assert.deepEqual(BUCKETS.map((b) => layerInfo(b).label), ["Floor", "Walls", "Ceiling", "Furniture"]);
  // Same colours and shortcuts, so painting works the same in both scenes.
  for (const l of LAYERS) {
    assert.deepEqual(EXTERIOR_LAYER_INFO[l].color, LAYER_INFO[l].color);
    assert.equal(EXTERIOR_LAYER_INFO[l].shortcut, LAYER_INFO[l].shortcut);
  }
  assert.ok(ZONES.filter((z) => z.scene === "exterior").every((z) => z.wet), "every exterior system must be weather-rated");
});

test("exterior Auto-detect protects openings, sky and trees, and never asks SAM3 for 'car'", () => {
  const g = buildSegmentationGraph({ image: "x.png", samCheckpoint: "sam3.safetensors", layers: LAYERS, prefix: "p", scene: "exterior" });
  const texts = Object.values(g.prompt).filter((n) => n.class_type === "CLIPTextEncode").map((n) => String(n.inputs.text));
  assert.equal(texts.length, 5);
  const prot = texts[4];
  for (const c of ["window", "door", "sky", "tree", "vehicle", "railing"]) assert.match(prot, new RegExp(`\\b${c}:`));
  // Measured on a real house photo: "car" and "parked car" detected the house itself.
  assert.ok(!texts.some((t) => /\bcar:/.test(t)));
  assert.ok(!/lawn|grass/.test(texts[3]), "lawn/grass took the whole yard away from the ground layer");
  const interior = buildSegmentationGraph({ image: "x.png", samCheckpoint: "s", layers: ["walls"], prefix: "p" });
  assert.equal(Object.values(interior.prompt).find((n) => n.class_type === "CLIPTextEncode")!.inputs.text, "wall:8");
});

test("exterior suggestions are weather-rated exterior systems; rooms never get them", () => {
  for (const zone of ["house-exterior", "commercial-exterior"] as const)
    for (const b of BUCKETS)
      for (const fam of ["stone", "wood", "tile", "concrete", "plain", "fabric", "metal"] as const) {
        const m = findMaterial(suggestMaterial(b, zone, fake(fam)).materialId);
        assert.ok(m, `${zone}/${b}/${fam}`);
        assert.equal(materialScene(m!), "exterior", `${m!.id} on ${zone} ${b}`);
        assert.ok(m!.buckets.includes(b) && m!.wetOk, `${m!.id} valid for ${b}`);
      }
  for (const b of BUCKETS)
    for (const fam of ["stone", "wood", "metal", "plain"] as const) assert.equal(materialScene(findMaterial(suggestMaterial(b, "living", fake(fam)).materialId)!), "interior");
  assert.equal(suggestMaterial("walls", "house-exterior", fake("stone")).materialId, "ext-stone-veneer");
  assert.equal(suggestMaterial("ceiling", "house-exterior", fake("metal")).materialId, "roof-longspan");
  assert.equal(suggestMaterial("floor", "house-exterior", undefined).materialId, "pave-concrete-pavers");
  // The project's material list is its scene's only.
  assert.ok(materialsForZone("house-exterior").every((m) => m.scene === "exterior"));
  assert.ok(!materialsForZone("living").some((m) => m.scene === "exterior"));
  assert.ok(MATERIALS.filter((m) => m.scene === "exterior").every((m) => m.wetOk && m.zones !== "any"));
});

test("exterior styles use real exterior systems on every surface; rooms keep their own styles", () => {
  const ext = stylesForZone("house-exterior");
  assert.ok(ext.length >= 3 && ext.every((s) => s.scene === "exterior"));
  assert.ok(stylesForZone("living").every((s) => !s.scene));
  for (const sp of ext)
    for (const b of ["floor", "walls", "ceiling"] as const) {
      const id = styleMaterialFor(sp, b, "house-exterior", MATERIALS)!;
      assert.equal(id, sp.materials[b], `${sp.id} ${b} kept as specified`);
      assert.equal(materialScene(findMaterial(id)!), "exterior");
    }
  // Clay tiles are specified for houses only; a commercial exterior gets the equivalent tile system.
  const med = STYLE_PRESETS.find((s) => s.id === "ext-mediterranean")!;
  const roof = findMaterial(styleMaterialFor(med, "ceiling", "commercial-exterior", MATERIALS));
  assert.ok(roof && roof.id !== "roof-clay-tile" && materialScene(roof) === "exterior" && roof.buckets.includes("ceiling"));
});

test("exterior BOQ: facade = length × height less openings, roof and landscape from their own areas", () => {
  const a = measuredAreas(house);
  assert.equal(a.walls, 12 * 4 * 0.75);
  assert.equal(a.ceiling, 100);
  assert.equal(a.floor, 30);
  assert.equal(a.landscape, 15);
  // No square-room guess for a facade.
  assert.equal(measuredAreas({ ...house, perimeter: 0 }).walls, 0);
  const boq = computeBoq(house, { floor: findMaterial("pave-concrete-pavers"), walls: findMaterial("ext-elastomeric-paint"), ceiling: findMaterial("roof-longspan"), furniture: findMaterial("land-planting-bed") });
  const byBucket = Object.fromEntries(boq.sections.map((s) => [s.bucket, s]));
  assert.deepEqual(boq.sections.map((s) => s.label), ["Ground", "Facade", "Roof", "Landscape"]);
  assert.equal(byBucket.walls.netQty, 36);
  assert.equal(byBucket.ceiling.netQty, 100);
  assert.equal(byBucket.furniture.netQty, 15);
  // Interior rooms are unchanged: the ceiling equals the floor area.
  const room = measuredAreas({ ...house, zone: "living", roofArea: undefined });
  assert.equal(room.ceiling, room.floor);
});

test("exterior prompts describe an exterior photograph and name the facade and roof", () => {
  const roof = findMaterial("roof-longspan");
  assert.match(globalPrompt("house-exterior", [], ""), /architectural exterior photograph of a house exterior/);
  assert.match(globalPrompt("living", [], ""), /interior photograph of a living room/);
  assert.match(surfacePrompt("ceiling", roof, undefined, "", "exterior"), /^roof: pre-painted long span metal roofing/);
  assert.match(surfacePrompt("walls", findMaterial("ext-stone-veneer"), undefined, "", "exterior"), /^building facade: /);
  assert.match(surfacePrompt("ceiling", findMaterial("mr-gypsum-ceiling"), undefined, ""), /^ceiling: /);
});

test("exterior guidelines and checks: weather practice, no interior slab or wet-room notes", () => {
  const g = buildGuidelines("house-exterior", { ceiling: findMaterial("roof-longspan"), walls: findMaterial("ext-elastomeric-paint") });
  const text = g.flatMap((x) => x.items).join("\n");
  assert.match(text, /wind-zone/i);
  assert.match(text, /1\.5%/);
  assert.doesNotMatch(text, /slab moisture|epoxy grout|ASTM F2170/);

  const project = {
    meta: { ...house, perimeter: 0, roofArea: 0, client: "Ana" },
    base: null,
    buckets: Object.fromEntries(BUCKETS.map((b) => [b, { enabled: b !== "furniture", refs: [], materialId: b === "walls" ? "ext-elastomeric-paint" : b === "ceiling" ? "roof-longspan" : null, materialPinned: true, weight: 0.85, note: "" }])),
    masks: Object.fromEntries([...BUCKETS, "protected"].map((l) => [l, { blobId: null, source: null, coverage: l === "floor" ? 0.2 : 0 }])),
  } as unknown as Project;
  const boq = computeBoq(project.meta, { walls: findMaterial("ext-elastomeric-paint"), ceiling: findMaterial("roof-longspan") });
  const checks = proposalChecks(project, MATERIALS, boq, buildProgramme(boq)).map((c) => c.text).join("\n");
  assert.match(checks, /Enter the facade length and height, roof area in the Project tab/);
  assert.doesNotMatch(checks, /Floor area is 0/);
});

test("exterior proposal states the facade, roof and paving basis", () => {
  const boq = computeBoq(house, { walls: findMaterial("ext-elastomeric-paint"), ceiling: findMaterial("roof-longspan") });
  const html = renderProposalHtml({
    project: { name: "House", meta: house, zoneLabel: "House exterior", date: "7 November 2026" },
    images: { hero: "", before: "", after: "" },
    schedule: [],
    boq,
    programme: buildProgramme(boq),
    guidelines: buildGuidelines("house-exterior", {}),
    render: { seed: 1, profile: "lite", width: 10, height: 10 },
    paper: "A4",
  } as unknown as Parameters<typeof renderProposalHtml>[0]);
  assert.match(html, /Basis: facade 36 m² \(12 m long × 4 m high, less 25% openings\) · roof 100 m² · paving 30 m²/);
  assert.doesNotMatch(html, /room dimensions/);
});
