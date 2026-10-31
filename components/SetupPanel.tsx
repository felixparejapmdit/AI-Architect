"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Circle, Loader2, Minus, Play, RotateCw, Wand2, X } from "lucide-react";
import { refreshDoctor, toast, useStore } from "@/lib/store";
import { formatBytes } from "@/lib/models-catalog";
import { fetchSetupReport, followSetupJob, postSetup, startComfyFromStrata } from "@/lib/setup-client";
import type { SetupJobView, SetupReport, SetupStep } from "@/lib/setup-shared";
import { Button, cx } from "./ui";

const KIND: Record<NonNullable<SetupReport["install"]>["kind"], string> = { manual: "manual install", portable: "portable build", desktop: "ComfyUI Desktop" };

// One watcher per setup job, even if the panel is closed and reopened mid-setup. It outlives the
// panel, so the outcome is announced (and ComfyUI's model lists refreshed) wherever the user is.
let announcing = false;
async function announceWhenDone() {
  if (announcing) return;
  announcing = true;
  try {
    const end = await followSetupJob();
    await refreshDoctor(true);
    if (end?.scope === "full") toast(end.status === "done" ? "Setup complete: Strata and ComfyUI are ready." : end.status === "cancelled" ? "Setup cancelled" : `Setup stopped: ${end.error}`, end.status === "done" ? "success" : end.status === "cancelled" ? "info" : "error");
  } finally {
    announcing = false;
  }
}

/**
 * One-click setup: shows what Strata found (ComfyUI folder, server and its flags, node packs,
 * models) and installs or starts whatever is missing, with live progress.
 */
export function SetupPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const online = useStore((s) => !!s.doctor?.online);
  const serverBusy = useStore((s) => s.serverBusy);
  const [report, setReport] = useState<SetupReport | null>(null);
  const [job, setJob] = useState<SetupJobView | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await fetchSetupReport();
      setReport(r.report);
      setJob(r.job);
      if (r.job?.status === "running" && r.job.scope === "full") void announceWhenDone();
    } finally {
      setLoading(false);
    }
  }, []);

  // Re-check when ComfyUI comes or goes, a start / restart finishes elsewhere in the app, or a
  // model download ends (refreshKey).
  useEffect(() => {
    void load();
  }, [load, online, serverBusy, refreshKey]);

  // Live progress while a job runs; a fresh report once it ends.
  const running = job?.status === "running";
  useEffect(() => {
    if (!running) return;
    let alive = true;
    const id = setInterval(async () => {
      const { job: next } = (await (await fetch("/api/setup?job=1", { cache: "no-store" })).json()) as { job: SetupJobView | null };
      if (!alive) return;
      setJob(next);
      if (next?.status !== "running") void load();
    }, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [running, load]);

  const run = async () => {
    const res = await postSetup("run");
    if (res.error) return toast(res.error, "error");
    if (res.job) setJob(res.job);
    void announceWhenDone();
  };
  const cancel = () => fetch("/api/setup", { method: "DELETE" });

  if (loading && !report) return <div className="flex items-center gap-2 rounded-lg border border-line p-3 text-xs text-mute"><Loader2 size={14} className="animate-spin" /> Checking ComfyUI and models…</div>;
  if (!report) return null;

  const r = report;
  const missingModels = r.models.filter((m) => !m.installed);
  const linked = missingModels.filter((m) => m.localCopy).length;
  const toDownload = missingModels.filter((m) => !m.convert && !m.localCopy);
  const conversions = missingModels.filter((m) => m.convert).length;
  const missingNodes = r.nodes.filter((n) => !n.installed);
  const issues = r.running?.issues ?? [];
  const flags = r.running ? r.running.argv.filter((a) => a.startsWith("--") && a !== "--listen" && a !== "--port").join(" ") || "default flags" : "";

  const plan: string[] = [];
  if (missingNodes.length) plan.push(`install ${missingNodes.map((n) => n.name).join(", ")}`);
  if (!r.running) plan.push(`start ComfyUI with ${r.gpu ? "GPU defaults" : "--cpu"}`);
  else if (issues.length || missingNodes.length) plan.push("restart ComfyUI with the recommended flags");
  if (linked) plan.push(`reuse ${linked} model${linked > 1 ? "s" : ""} already on this machine`);
  if (toDownload.length) plan.push(`download ${toDownload.length} model${toDownload.length > 1 ? "s" : ""} (${formatBytes(r.downloadBytes)})`);
  if (conversions) plan.push(`make ${conversions} low-memory cop${conversions > 1 ? "ies" : "y"}`);

  return (
    <section aria-label="Setup" className="rounded-lg border border-line">
      <header className="flex items-center gap-2 px-3 pb-1 pt-3">
        <Wand2 size={15} className="text-accent" />
        <h3 className="text-[13px] font-semibold">Setup</h3>
        <span className={cx("ml-auto text-xs", r.ready ? "font-medium text-ok" : "text-mute")}>
          {r.ready ? "Everything is ready" : `${r.profile === "studio" ? "Studio (GPU)" : "Lite (CPU)"} profile for this machine`}
        </span>
      </header>
      <ul className="divide-y divide-line px-3 text-xs">
        <Row state={r.install ? "ok" : "bad"} label="ComfyUI">
          {r.install ? (
            <>
              <span className="break-all">{r.install.path}</span> · {KIND[r.install.kind]} · {r.install.gpuTorch === null ? "PyTorch not found" : r.install.gpuTorch ? "GPU PyTorch" : "CPU PyTorch"}
              {r.others.length > 0 && <span className="text-faint"> · {r.others.length} other install{r.others.length > 1 ? "s" : ""} found</span>}
            </>
          ) : (
            "Not found. Install ComfyUI (manual, portable or Desktop), or set its folder in Settings."
          )}
        </Row>
        <Row
          state={!r.running ? "bad" : issues.length ? "warn" : "ok"}
          label="Server"
          action={
            !running && r.install?.canStart && (!r.running || issues.length > 0) ? (
              <Button size="sm" disabled={serverBusy} onClick={() => void startComfyFromStrata(!!r.running)}>
                {serverBusy ? <Loader2 size={12} className="animate-spin" /> : r.running ? <RotateCw size={12} /> : <Play size={12} />} {r.running ? "Restart" : "Start"}
              </Button>
            ) : null
          }
        >
          {r.running ? (
            <>
              {r.running.url.replace(/^https?:\/\//, "")} · ComfyUI {r.running.version} on {r.running.device === "cpu" ? "CPU" : "GPU"} · <code>{flags}</code>
              {issues.map((i) => (
                <span key={i.flag} className="block text-amber-800">
                  <code>{i.flag}</code> {i.problem}
                </span>
              ))}
            </>
          ) : (
            <>Not running. Strata starts it with <code>{r.launchArgs.filter((a) => a.startsWith("--") && a !== "--listen").join(" ")}</code>.</>
          )}
        </Row>
        <Row state={missingNodes.length ? "bad" : "ok"} label="Node packs">
          {missingNodes.length ? `Missing: ${missingNodes.map((n) => n.name).join(", ")}` : r.nodes.map((n) => n.name).join(", ") || "None needed"}
        </Row>
        <Row state={missingModels.length ? "bad" : "ok"} label="Models">
          {r.models.length - missingModels.length} of {r.models.length} installed
          {toDownload.length > 0 && <> · {toDownload.length} to download ({formatBytes(r.downloadBytes)})</>}
          {linked > 0 && <> · {linked} found on this machine (linked, not downloaded)</>}
          {conversions > 0 && <> · {conversions} low-memory cop{conversions > 1 ? "ies" : "y"} to make</>}
          {r.diskFree !== null && <span className="text-faint"> · {formatBytes(r.diskFree)} free</span>}
        </Row>
      </ul>

      {job && (running || job.scope === "full") && <Steps job={job} />}

      <footer className="flex items-center gap-2 border-t border-line px-3 py-2.5">
        {running ? (
          <>
            <span className="flex items-center gap-1.5 text-xs text-mute"><Loader2 size={13} className="animate-spin" /> {job?.scope === "server" ? "Starting ComfyUI…" : "Setting up… you can keep working."}</span>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void cancel()}><X size={12} /> Cancel</Button>
          </>
        ) : r.ready ? (
          <span className="text-xs text-mute">ComfyUI is running with the right flags and every model this machine needs is installed.</span>
        ) : (
          <>
            <span className="min-w-0 flex-1 text-xs leading-snug text-mute">{plan.length ? `Will ${plan.join(", ")}.` : "Will check everything again."}</span>
            <Button size="sm" variant="primary" disabled={!r.install || serverBusy} onClick={() => void run()}>
              <Wand2 size={12} /> Set up everything
            </Button>
          </>
        )}
      </footer>
    </section>
  );
}

function Row({ state, label, action, children }: { state: "ok" | "warn" | "bad"; label: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 py-2">
      {state === "ok" ? <Check size={13} className="mt-px shrink-0 text-ok" /> : state === "warn" ? <AlertTriangle size={13} className="mt-px shrink-0 text-amber-600" /> : <X size={13} className="mt-px shrink-0 text-danger" />}
      <span className="w-[76px] shrink-0 font-medium">{label}</span>
      <span className="min-w-0 flex-1 leading-snug text-mute">{children}</span>
      {action && <span className="shrink-0">{action}</span>}
    </li>
  );
}

function StepIcon({ status }: { status: SetupStep["status"] }) {
  if (status === "running") return <Loader2 size={13} className="mt-px shrink-0 animate-spin text-accent" />;
  if (status === "done") return <Check size={13} className="mt-px shrink-0 text-ok" />;
  if (status === "error") return <X size={13} className="mt-px shrink-0 text-danger" />;
  if (status === "skipped") return <Minus size={13} className="mt-px shrink-0 text-faint" />;
  return <Circle size={11} className="mt-0.5 shrink-0 text-faint" />;
}

function Steps({ job }: { job: SetupJobView }) {
  return (
    <ol aria-label="Setup progress" className="space-y-1.5 border-t border-line bg-paper/60 px-3 py-2.5 text-xs">
      {job.steps.map((s) => (
        <li key={s.id} className="flex items-start gap-2">
          <StepIcon status={s.status} />
          <span className="min-w-0 flex-1">
            <span className={cx(s.status === "pending" || s.status === "skipped" ? "text-faint" : "text-ink")}>{s.label}</span>
            {s.detail && <span className={cx("block break-words leading-snug", s.status === "error" ? "text-danger" : "text-mute")}>{s.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}
