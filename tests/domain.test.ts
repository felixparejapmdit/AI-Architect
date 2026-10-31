import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBoq, measuredAreas, VAT_RATE } from "../lib/boq";
import { MATERIALS, findMaterial, suggestMaterial } from "../lib/materials";
import { buildGuidelines } from "../lib/guidelines";
import { analyzeTexture, equalizeLighting, illumination } from "../lib/texture";
import { buildProgramme, proposalChecks, spanLabel } from "../lib/programme";
import { STYLE_PRESETS, styleMaterialFor } from "../lib/styles";
import { renderProposalHtml } from "../lib/proposal";
import type { Project, ProjectMeta, TextureAnalysis } from "../lib/types";

const meta: ProjectMeta = { client: "", location: "", preparedBy: "", zone: "living", floorArea: 25, ceilingHeight: 3, perimeter: 20, openingsPct: 10, furniturePieces: 2, contingencyPct: 10 };
const fake = (family: TextureAnalysis["family"]): TextureAnalysis => ({ family, confidence: 0.8, swatch: "#cccccc", tone: "light", warmth: "neutral", features: {} });

test("areas: walls are perimeter × height less openings", () => {
  const a = measuredAreas(meta);
  assert.equal(a.walls, 20 * 3 * 0.9);
  assert.equal(measuredAreas({ ...meta, perimeter: 0 }).perimeter, 20);
});

test("BOQ totals add up with contingency and 12% VAT", () => {
  const boq = computeBoq(meta, { floor: findMaterial("sintered-stone-12"), walls: findMaterial("anti-mold-paint") });
  assert.equal(boq.sections.length, 2);
  const floor = boq.sections[0];
  assert.equal(floor.lines[0].qty, 28); // 25 m² + 12% wastage
  const sum = boq.sections.reduce((s, x) => s + x.subtotal, 0);
  assert.ok(Math.abs(boq.subtotal - sum) < 0.01);
  assert.ok(Math.abs(boq.vat - (boq.subtotal + boq.contingency) * VAT_RATE) < 0.01);
  assert.ok(Math.abs(boq.total - (boq.subtotal + boq.contingency + boq.vat)) < 0.01);
});

test("wet-zone porcelain always carries epoxy grout in the BOQ", () => {
  const boq = computeBoq({ ...meta, zone: "bathroom" }, { floor: findMaterial("slim-porcelain-6") });
  assert.ok(boq.sections[0].lines.some((l) => /epoxy grout/i.test(l.description)));
});

test("material rules: stone in a living room → sintered stone", () => {
  assert.equal(suggestMaterial("floor", "living", fake("stone")).materialId, "sintered-stone-12");
});

test("material rules: any bathroom floor → wet-rated slim porcelain", () => {
  for (const fam of ["stone", "wood", "tile", "plain"] as const) {
    const id = suggestMaterial("floor", "bathroom", fake(fam)).materialId;
    assert.ok(findMaterial(id)!.wetOk, `${fam} → ${id} must be wet-rated`);
  }
  assert.equal(suggestMaterial("floor", "bathroom", fake("stone")).materialId, "slim-porcelain-6");
});

test("material rules: parking and office floors → PU-cement screed", () => {
  assert.equal(suggestMaterial("floor", "parking", fake("concrete")).materialId, "pu-cement-screed");
  assert.equal(suggestMaterial("floor", "office", undefined).materialId, "pu-cement-screed");
});

test("every suggestion is a real catalogue entry for that surface", () => {
  for (const bucket of ["floor", "walls", "ceiling", "furniture"] as const)
    for (const zone of ["living", "bathroom", "kitchen", "office", "parking", "outdoor-covered"] as const)
      for (const fam of ["stone", "wood", "tile", "concrete", "plain", "fabric", "metal"] as const) {
        const m = findMaterial(suggestMaterial(bucket, zone, fake(fam)).materialId);
        assert.ok(m, `${bucket}/${zone}/${fam}`);
        assert.ok(m!.buckets.includes(bucket), `${m!.id} not valid for ${bucket}`);
      }
});

test("guidelines warn against floating floors over concrete when a wood-look floor is chosen", () => {
  const g = buildGuidelines("living", { floor: findMaterial("spc-plank") });
  assert.ok(g.flatMap((x) => x.items).some((i) => /floating floors/i.test(i)));
});

function synth(w: number, h: number, fn: (x: number, y: number) => [number, number, number]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      data.set([r, g, b, 255], (y * w + x) * 4);
    }
  return { data, width: w, height: h };
}

test("texture: flat colour reads as plain", () => {
  assert.equal(analyzeTexture(synth(96, 96, () => [235, 233, 228])).family, "plain");
});

test("texture: warm directional grain reads as wood", () => {
  const a = analyzeTexture(synth(128, 128, (x, y) => {
    const v = 140 + 40 * Math.sin(y * 0.9 + Math.sin(x * 0.05) * 2);
    return [v + 40, v * 0.75, v * 0.45];
  }));
  assert.equal(a.family, "wood");
  assert.equal(a.warmth, "warm");
});

test("texture: grout grid reads as tile", () => {
  const a = analyzeTexture(synth(128, 128, (x, y) => (x % 32 < 2 || y % 32 < 2 ? [90, 90, 90] : [210, 208, 204])));
  assert.equal(a.family, "tile");
});

test("proposal HTML escapes user text and includes every section", () => {
  const html = renderProposalHtml({
    project: { name: "<script>x</script> Villa", meta, zoneLabel: "Living room", date: "1 Jan 2026" },
    images: { hero: "data:image/jpeg;base64,AA", before: "data:,", after: "data:," },
    schedule: [{ bucket: "floor", label: "Floor", material: MATERIALS[0], swatches: [], colour: "#ffffff" }],
    boq: computeBoq(meta, { floor: MATERIALS[0] }),
    guidelines: buildGuidelines("living", { floor: MATERIALS[0] }),
    render: { seed: 1, profile: "lite", width: 3840, height: 2560 },
    paper: "A4",
  });
  assert.ok(!html.includes("<script>x</script>"));
  for (const s of ["Before &amp; after", "Material mood board", "Bill of quantities", "Tropical installation guidelines", "VAT (12%)"]) assert.ok(html.includes(s), s);
});

test("lighting equalizer flattens a light falloff but leaves evenly lit samples untouched", () => {
  const W = 128, H = 128;
  // Wood-like stripes (period 8 px) as the material, plus a strong left-to-right falloff.
  const material = (x: number, y: number) => 150 + 40 * Math.sin((y / 8) * Math.PI * 2) + 10 * Math.sin(x / 3);
  const make = (light: (x: number) => number) => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = material(x, y) * light(x);
      data.set([v, v * 0.8, v * 0.6, 255], (y * W + x) * 4);
    }
    return { data, width: W, height: H };
  };
  const colMeans = (px: { data: Uint8ClampedArray }) => Array.from({ length: W }, (_, x) => {
    let s = 0;
    for (let y = 0; y < H; y++) s += px.data[(y * W + x) * 4];
    return s / H;
  });
  const spread = (v: number[]) => Math.max(...v.slice(16, -16)) - Math.min(...v.slice(16, -16));

  const uneven = make((x) => 0.45 + 0.9 * (x / (W - 1)));
  const before = spread(colMeans(uneven));
  assert.ok(illumination(uneven).spread > 0.5);
  assert.equal(equalizeLighting(uneven), 1);
  assert.ok(spread(colMeans(uneven)) < before * 0.5, "falloff at least halved");
  // Detail survives: the stripes are still there at full contrast within a column.
  const col = Array.from({ length: H }, (_, y) => uneven.data[(y * W + 64) * 4]);
  assert.ok(Math.max(...col) - Math.min(...col) > 50);
  // Colour ratios are kept (one gain per pixel for R, G and B).
  const i = (40 * W + 30) * 4;
  assert.ok(Math.abs(uneven.data[i + 1] / uneven.data[i] - 0.8) < 0.03);

  const even = make(() => 1);
  const copy = new Uint8ClampedArray(even.data);
  assert.equal(equalizeLighting(even), 0);
  assert.deepEqual(even.data, copy);
});

test("programme: top-down trades, each waiting for its material and the trade before", () => {
  const boq = computeBoq(meta, { floor: findMaterial("sintered-stone-12"), walls: findMaterial("anti-mold-paint"), ceiling: findMaterial("mr-gypsum-ceiling") });
  const prog = buildProgramme(boq);
  assert.deepEqual(prog.tasks.map((t) => t.bucket), ["ceiling", "walls", "floor"]);
  const [ceiling, walls, floor] = prog.tasks;
  assert.equal(ceiling.installDays, Math.ceil(25 / 10));
  assert.equal(ceiling.startDay, 5, "gypsum boards arrive after 5 days");
  assert.equal(walls.startDay, ceiling.endDay);
  // Sintered stone takes 21 days to arrive, so the floor waits for it, not for the walls.
  assert.equal(floor.startDay, Math.max(walls.endDay, 21));
  assert.equal(prog.totalDays, floor.endDay);
  assert.deepEqual(prog.longestLead, { material: findMaterial("sintered-stone-12")!.name, days: 21 });
  assert.equal(spanLabel(9), "9 days");
  assert.equal(spanLabel(35), "5 weeks");
});

test("proposal checks: budget overrun with cheaper zone-safe options, late handover, gaps", () => {
  const project = {
    meta: { ...meta, client: "", budgetPhp: 150_000, targetDate: "2026-11-10" },
    base: { blobId: "b", editBlobId: "e", name: "room", width: 10, height: 10, editWidth: 10, editHeight: 10 },
    buckets: {
      floor: { enabled: true, refs: [], materialId: "sintered-stone-12", materialPinned: true, weight: 0.85, note: "" },
      walls: { enabled: true, refs: [], materialId: null, materialPinned: false, weight: 0.85, note: "" },
      ceiling: { enabled: true, refs: [], materialId: "mr-gypsum-ceiling", materialPinned: true, weight: 0.85, note: "" },
      furniture: { enabled: false, refs: [], materialId: null, materialPinned: false, weight: 0.7, note: "" },
    },
    masks: { floor: { blobId: "f", source: "manual", coverage: 0.3 }, walls: { blobId: "w", source: "manual", coverage: 0.2 }, ceiling: { blobId: null, source: null, coverage: 0 }, furniture: { blobId: null, source: null, coverage: 0 }, protected: { blobId: null, source: null, coverage: 0 } },
  } as unknown as Project;
  const boq = computeBoq(project.meta, { floor: findMaterial("sintered-stone-12"), ceiling: findMaterial("mr-gypsum-ceiling") });
  const checks = proposalChecks(project, MATERIALS, boq, buildProgramme(boq), new Date("2026-11-01T00:00:00"));
  const text = checks.map((c) => `${c.level}: ${c.text}`).join("\n");
  assert.match(text, /warn: Estimate .* over the ₱150,000 budget/);
  // The cheapest floor the living-room rules allow, never a wet-zone or parking-only system.
  assert.match(text, /info: Floor: .* instead of Sintered stone/);
  assert.doesNotMatch(text, /PU-cement|polyurethane/i);
  assert.match(text, /warn: Indicative handover .* after the .* target; Sintered stone, large format 12 mm has the longest lead time \(21 days\)/);
  assert.match(text, /warn: Walls is masked but has no material/);
  assert.match(text, /info: Ceiling is costed but not masked/);
  assert.match(text, /info: Add the client's name/);

  const rich = { ...project, meta: { ...project.meta, budgetPhp: 10_000_000, targetDate: "2027-06-01", client: "Ana" } };
  const ok = proposalChecks(rich, MATERIALS, boq, buildProgramme(boq), new Date("2026-11-01T00:00:00"));
  assert.ok(ok.some((c) => c.level === "ok" && /Within the/.test(c.text)));
  assert.ok(ok.some((c) => c.level === "ok" && /before the/.test(c.text)));
});

test("styles: coordinated catalogue finishes, swapped for wet-rated ones in wet zones", () => {
  for (const sp of STYLE_PRESETS) for (const b of ["floor", "walls", "ceiling"] as const) {
    const id = styleMaterialFor(sp, b, "living", MATERIALS);
    assert.ok(id && findMaterial(id)?.buckets.includes(b), `${sp.id} ${b}`);
  }
  const tropical = STYLE_PRESETS.find((s) => s.id === "warm-tropical")!;
  assert.equal(styleMaterialFor(tropical, "floor", "living", MATERIALS), "spc-plank");
  const wetFloor = styleMaterialFor(tropical, "floor", "bathroom", MATERIALS)!;
  assert.ok(findMaterial(wetFloor)!.wetOk, "a wood-look plank is not wet-rated; the bathroom gets a wet-rated floor");
  // PU-cement is specified for offices, parking and kitchens, not living rooms.
  assert.equal(styleMaterialFor(STYLE_PRESETS.find((s) => s.id === "industrial")!, "floor", "living", MATERIALS), "microcement");
});

test("proposal HTML includes the programme when there is one", () => {
  const boq = computeBoq(meta, { floor: MATERIALS[0] });
  const html = renderProposalHtml({
    project: { name: "Villa", meta, zoneLabel: "Living room", date: "1 Jan 2026" },
    images: { hero: "data:,", before: "data:,", after: "data:," },
    schedule: [],
    boq,
    programme: buildProgramme(boq),
    guidelines: [],
    render: { seed: 1, profile: "lite", width: 10, height: 10 },
    paper: "A4",
  });
  assert.ok(html.includes("Indicative programme"));
  assert.ok(html.includes('<span class="num">05</span><h2>Tropical installation guidelines'));
});
