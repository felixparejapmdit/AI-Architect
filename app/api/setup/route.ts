import { applyDetected, buildReport, cancelSetup, getSetupJob, startSetup } from "@/lib/server/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `?job=1` returns only the running setup job (cheap enough to poll every second). */
export async function GET(req: Request) {
  const job = getSetupJob();
  if (new URL(req.url).searchParams.has("job")) return Response.json({ job });
  const { port: _port, ...report } = await buildReport();
  return Response.json({ report, job });
}

/**
 * Body { action }:
 *  - "detect": find ComfyUI and save its folder and URL
 *  - "run": one-click setup (nodes, start / restart, models, conversions)
 *  - "start": start ComfyUI, or restart it when its flags break Strata
 *  - "restart": restart ComfyUI with the recommended flags
 */
export async function POST(req: Request) {
  const { action } = (await req.json().catch(() => ({}))) as { action?: string };
  try {
    if (action === "detect") return Response.json({ report: await applyDetected() });
    if (action === "run") return Response.json({ job: startSetup("full") });
    if (action === "start") return Response.json({ job: startSetup("server") });
    if (action === "restart") return Response.json({ job: startSetup("server", { restart: true }) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
  return Response.json({ error: "Unknown action" }, { status: 400 });
}

export async function DELETE() {
  cancelSetup();
  return Response.json({ ok: true });
}
