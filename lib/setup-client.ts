"use client";

import { refreshDoctor, toast, useStore } from "./store";
import type { SetupJobView, SetupReport } from "./setup-shared";

export type SetupAction = "detect" | "run" | "start" | "restart";

export async function fetchSetupReport(): Promise<{ report: SetupReport; job: SetupJobView | null }> {
  const res = await fetch("/api/setup", { cache: "no-store" });
  return res.json();
}

export async function postSetup(action: SetupAction): Promise<{ job?: SetupJobView; report?: SetupReport; error?: string }> {
  const res = await fetch("/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
  return res.json();
}

/** Polls the setup job until it ends (or `until` says enough), passing each state to `onUpdate`. */
export async function followSetupJob(onUpdate?: (job: SetupJobView) => void, until?: (job: SetupJobView) => boolean): Promise<SetupJobView | null> {
  for (;;) {
    const { job } = (await (await fetch("/api/setup?job=1", { cache: "no-store" })).json()) as { job: SetupJobView | null };
    if (job) onUpdate?.(job);
    if (!job || job.status !== "running" || until?.(job)) return job;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** The server step of a running full setup has settled, though its model downloads may go on for hours. */
function serverStepSettled(job: SetupJobView): boolean {
  const server = job.steps.find((s) => s.id === "server");
  return job.scope === "full" && !!server && server.status !== "pending" && server.status !== "running";
}

/** Starts ComfyUI from Strata (or restarts it with the recommended flags) and reports the outcome. */
export async function startComfyFromStrata(restart = false) {
  if (useStore.getState().serverBusy) return;
  useStore.setState({ serverBusy: true });
  try {
    const res = await postSetup(restart ? "restart" : "start");
    if (res.error) throw new Error(res.error);
    toast(restart ? "Restarting ComfyUI with the recommended flags…" : "Starting ComfyUI… this takes a minute or two on CPU.", "info");
    const job = await followSetupJob(undefined, serverStepSettled);
    await refreshDoctor(true);
    const server = job?.steps.find((s) => s.id === "server");
    const failed = job?.status === "running" ? server?.status === "error" : job?.status !== "done";
    if (!failed) toast(server?.detail ?? "ComfyUI is running", server?.status === "skipped" ? "info" : "success");
    else toast(job?.error ?? server?.detail ?? "Could not start ComfyUI", "error");
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), "error");
  } finally {
    useStore.setState({ serverBusy: false });
  }
}
