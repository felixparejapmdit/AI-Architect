import { computeBoq, php, type Boq } from "./boq";
import { isWetZone, layerInfo, sceneOf } from "./buckets";
import { materialScene, type Material } from "./materials";
import type { BucketId, Project } from "./types";

/**
 * Indicative installation programme and pre-export checks for the proposal: the cost +
 * timeline + "is this realistic?" pass a proposal writer does, done deterministically from the
 * BOQ and the material library (no LLM, works offline).
 */

/** Used when a library material has no programme data (e.g. a custom entry). */
const FALLBACK = { "m²": { crewRate: 10, leadDays: 7, cureDays: 0 }, pc: { crewRate: 1, leadDays: 14, cureDays: 0 } } as const;

/** Finishes go on top-down so later trades never work over finished ones; loose furniture last. */
const SITE_ORDER: BucketId[] = ["ceiling", "walls", "floor", "furniture"];
/** Metro Manila fit-out crews usually work Monday to Saturday. */
export const WORK_DAYS_PER_WEEK = 6;

export interface ProgrammeTask {
  bucket: BucketId;
  label: string;
  material: string;
  qty: number;
  unit: string;
  /** Working days on site, one crew. */
  installDays: number;
  cureDays: number;
  leadDays: number;
  /** Calendar days from order to the start / end of this trade. */
  startDay: number;
  endDay: number;
  /** The material had no programme data; library fallbacks were used. */
  assumed: boolean;
}

export interface Programme {
  tasks: ProgrammeTask[];
  /** Calendar days from order to handover. */
  totalDays: number;
  longestLead: { material: string; days: number } | null;
}

const toCalendar = (workDays: number) => Math.ceil((workDays * 7) / WORK_DAYS_PER_WEEK);

/** "9 days" under two weeks, else rounded weeks. */
export const spanLabel = (days: number) => (days < 14 ? `${days} day${days === 1 ? "" : "s"}` : `${Math.round(days / 7)} weeks`);

export function buildProgramme(boq: Boq): Programme {
  let day = 0;
  const tasks: ProgrammeTask[] = [];
  for (const bucket of SITE_ORDER) {
    const sec = boq.sections.find((s) => s.bucket === bucket);
    if (!sec) continue;
    const m = sec.material;
    const fb = FALLBACK[m.unit];
    const crewRate = m.crewRate && m.crewRate > 0 ? m.crewRate : fb.crewRate;
    const installDays = Math.max(1, Math.ceil(sec.netQty / crewRate));
    const cureDays = Math.max(0, m.cureDays ?? fb.cureDays);
    const leadDays = Math.max(0, m.leadDays ?? fb.leadDays);
    // A trade starts once its material is on site and the trade before it has finished.
    const startDay = Math.max(day, leadDays);
    const endDay = startDay + toCalendar(installDays + cureDays);
    tasks.push({ bucket, label: sec.label, material: m.name, qty: sec.netQty, unit: m.unit, installDays, cureDays, leadDays, startDay, endDay, assumed: m.crewRate === undefined || m.leadDays === undefined });
    day = endDay;
  }
  const lead = tasks.reduce<ProgrammeTask | null>((a, t) => (!a || t.leadDays > a.leadDays ? t : a), null);
  return { tasks, totalDays: day, longestLead: lead ? { material: lead.material, days: lead.leadDays } : null };
}

export interface Check {
  level: "ok" | "info" | "warn";
  text: string;
}

const DAY = 86_400_000;
const fmtDate = (d: Date) => d.toLocaleDateString("en-PH", { day: "numeric", month: "short", year: "numeric" });

/** Cheapest material the zone rules allow on this surface, if it is cheaper than `current`. */
function cheaperAlternative(project: Project, library: Material[], bucket: BucketId, current: Material, currentSubtotal: number) {
  const wet = isWetZone(project.meta.zone);
  let best: { material: Material; subtotal: number } | null = null;
  for (const m of library) {
    if (m.id === current.id || m.unit !== current.unit || !m.buckets.includes(bucket) || (wet && !m.wetOk) || materialScene(m) !== sceneOf(project.meta.zone)) continue;
    if (m.zones !== "any" && !m.zones.includes(project.meta.zone)) continue;
    const subtotal = computeBoq(project.meta, { [bucket]: m }).sections[0]?.subtotal ?? Infinity;
    if (subtotal < currentSubtotal && (!best || subtotal < best.subtotal)) best = { material: m, subtotal };
  }
  return best;
}

/**
 * What to fix or confirm before sending the proposal: budget and deadline against the estimate
 * and programme, surfaces that are masked but not specified (or the reverse), long-lead items.
 */
export function proposalChecks(project: Project, library: Material[], boq: Boq, programme: Programme, today = new Date()): Check[] {
  const checks: Check[] = [];
  const m = project.meta;
  const budget = m.budgetPhp ?? 0;
  if (budget > 0 && boq.sections.length) {
    // Contingency and VAT scale every saving the same way as the subtotal.
    const markup = boq.subtotal > 0 ? boq.total / boq.subtotal : 1;
    if (boq.total > budget) {
      const over = boq.total - budget;
      checks.push({ level: "warn", text: `Estimate ${php(boq.total, 0)} is ${php(over, 0)} (${Math.round((over / budget) * 100)}%) over the ${php(budget, 0)} budget.` });
      const options = boq.sections
        .map((sec) => ({ sec, alt: cheaperAlternative(project, library, sec.bucket, sec.material, sec.subtotal) }))
        .filter((x): x is { sec: Boq["sections"][number]; alt: { material: Material; subtotal: number } } => !!x.alt)
        .map(({ sec, alt }) => ({ sec, alt, saving: (sec.subtotal - alt.subtotal) * markup }))
        .sort((a, b) => b.saving - a.saving)
        .slice(0, 2);
      for (const o of options) checks.push({ level: "info", text: `${o.sec.label}: ${o.alt.material.name} instead of ${o.sec.material.name} saves about ${php(o.saving, 0)}.` });
    } else {
      checks.push({ level: "ok", text: `Within the ${php(budget, 0)} budget (${php(budget - boq.total, 0)} to spare).` });
    }
  }
  if (m.targetDate && programme.tasks.length) {
    const target = new Date(`${m.targetDate}T00:00:00`);
    const handover = new Date(today.getTime() + programme.totalDays * DAY);
    if (!Number.isNaN(target.getTime())) {
      const late = Math.ceil((handover.getTime() - target.getTime()) / DAY);
      if (late > 0) {
        const lead = programme.longestLead;
        checks.push({ level: "warn", text: `Indicative handover ${fmtDate(handover)} is ${late} day${late > 1 ? "s" : ""} after the ${fmtDate(target)} target${lead && lead.days >= 14 ? `; ${lead.material} has the longest lead time (${lead.days} days)` : ""}.` });
      } else {
        checks.push({ level: "ok", text: `Indicative handover ${fmtDate(handover)}, before the ${fmtDate(target)} target.` });
      }
    }
  }
  const scene = sceneOf(m.zone);
  if (scene === "interior" && m.floorArea <= 0) checks.push({ level: "warn", text: "Floor area is 0 m², so every quantity is empty. Enter the room size in the Project tab." });
  if (scene === "exterior") {
    const missing = [
      project.buckets.walls.materialId && (m.perimeter <= 0 || m.ceilingHeight <= 0) && "facade length and height",
      project.buckets.ceiling.materialId && !(m.roofArea && m.roofArea > 0) && "roof area",
      project.buckets.floor.materialId && m.floorArea <= 0 && "paving area",
    ].filter(Boolean);
    if (missing.length) checks.push({ level: "warn", text: `Enter the ${missing.join(", ")} in the Project tab; until then those finishes have no quantity.` });
  }
  for (const b of ["floor", "walls", "ceiling"] as const) {
    const bucket = project.buckets[b];
    const masked = project.masks[b].coverage > 0.001;
    const label = layerInfo(b, scene).label;
    if (bucket.enabled && masked && !bucket.materialId) checks.push({ level: "warn", text: `${label} is masked but has no material, so it is rendered but left out of the BOQ.` });
    if (project.base && bucket.enabled && bucket.materialId && !masked) checks.push({ level: "info", text: `${label} is costed but not masked, so the render does not show it.` });
  }
  for (const t of programme.tasks) if (t.leadDays >= 21) checks.push({ level: "info", text: `Order ${t.material} first: about ${t.leadDays} days lead time.` });
  if (!m.client.trim()) checks.push({ level: "info", text: "Add the client's name (Project tab) for the cover page." });
  return checks;
}
