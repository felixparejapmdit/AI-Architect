import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { comfyCandidates, driveRoots, getConfig, isComfyDir, setConfig, strataDir } from "./config";
import { formatBytes, MODEL_CATALOG, setupModels, setupNodes, type CatalogModel } from "../models-catalog";
import { cancelJob, findComfyPython, findLocalCopy, getJob, isInstalled, isNodePackInstalled, modelPath, startModelInstall, startNodeInstall } from "./downloads";
import {
  argvIssues,
  baseDirFromFolderPaths,
  formatDuration,
  launchArgs,
  pidFromNetstat,
  torchHasGpu,
  type InstallInfo,
  type InstallKind,
  type RunningInfo,
  type SetupJobView,
  type SetupReport,
  type SetupStep,
} from "../setup-shared";

const exec = promisify(execFile);
const GB = 1024 ** 3;
/** ComfyUI's default, a common second instance, ComfyUI Desktop's default, and two spares. */
const PORTS = [8188, 8189, 8000, 8190, 8288];
const win = process.platform === "win32";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SystemStats {
  system: { comfyui_version: string; argv?: string[]; ram_total: number };
  devices: { type: string; vram_total: number }[];
}

async function getJson<T>(url: string, ms: number): Promise<T | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms), cache: "no-store" });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

export const isLocalUrl = (u: string) => {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(u).hostname);
  } catch {
    return false;
  }
};

async function inspect(url: string): Promise<RunningInfo | null> {
  const s = await getJson<SystemStats>(`${url}/system_stats`, 2500);
  if (!s?.system) return null;
  const [paths, queue] = await Promise.all([
    getJson<Record<string, unknown>>(`${url}/internal/folder_paths`, 3000),
    getJson<{ queue_running: unknown[]; queue_pending: unknown[] }>(`${url}/queue`, 3000),
  ]);
  const dev = s.devices[0];
  const argv = s.system.argv ?? [];
  return {
    url,
    version: s.system.comfyui_version,
    device: dev?.type ?? "cpu",
    vramTotal: dev?.vram_total ?? 0,
    ramTotal: s.system.ram_total,
    argv,
    issues: argvIssues(argv, dev?.type ?? "cpu"),
    baseDir: paths ? baseDirFromFolderPaths(paths, path.sep) : null,
    queue: queue ? queue.queue_running.length + queue.queue_pending.length : 0,
    local: isLocalUrl(url),
  };
}

/** A running ComfyUI: the configured URL first, then the usual local ports. */
export async function findRunning(configured: string): Promise<RunningInfo | null> {
  const urls = [configured, ...PORTS.map((p) => `http://127.0.0.1:${p}`)].filter((u, i, a) => a.indexOf(u) === i);
  const found = await Promise.all(urls.map((u) => getJson<SystemStats>(`${u}/system_stats`, 2000)));
  const i = found.findIndex((s) => s?.system);
  return i < 0 ? null : inspect(urls[i]);
}

function torchVersionFile(dir: string, kind: InstallKind): string | null {
  const envs = kind === "portable" ? [path.join(dir, "..", "python_embeded")] : [path.join(dir, ".venv"), path.join(dir, "venv")];
  for (const env of envs) {
    const winPath = path.join(env, "Lib", "site-packages", "torch", "version.py");
    if (fs.existsSync(winPath)) return winPath;
    try {
      for (const py of fs.readdirSync(path.join(env, "lib"))) {
        const p = path.join(env, "lib", py, "site-packages", "torch", "version.py");
        if (fs.existsSync(p)) return p;
      }
    } catch {
      // no posix layout
    }
  }
  return null;
}

export function describeInstall(dir: string): InstallInfo {
  const hasMain = fs.existsSync(path.join(dir, "main.py"));
  const kind: InstallKind = !hasMain ? "desktop" : fs.existsSync(path.join(dir, "..", "python_embeded")) ? "portable" : "manual";
  const python = findComfyPython(dir);
  const tv = torchVersionFile(dir, kind);
  let gpuTorch: boolean | null = null;
  try {
    if (tv) gpuTorch = torchHasGpu(fs.readFileSync(tv, "utf8"));
  } catch {
    // unreadable: unknown
  }
  return { path: dir, kind, python, gpuTorch, canStart: kind !== "desktop" && !!python };
}

const vramCache = globalThis as unknown as { __strataVram?: number };
/** Total VRAM of the largest NVIDIA GPU in GB, 0 without one (nvidia-smi ships with the driver). */
async function nvidiaVramGb(): Promise<number> {
  if (vramCache.__strataVram !== undefined) return vramCache.__strataVram;
  try {
    const { stdout } = await exec("nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"], { timeout: 5000, windowsHide: true });
    vramCache.__strataVram = Math.max(0, ...stdout.split(/\r?\n/).map(Number).filter(Number.isFinite)) / 1024;
  } catch {
    vramCache.__strataVram = 0;
  }
  return vramCache.__strataVram;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

/**
 * Where else this machine may already hold the same model files: other ComfyUI folders,
 * A1111 / Forge / Fooocus / SD.Next / StabilityMatrix installs, and Downloads.
 */
export function localRoots(target: string, comfyDirs: string[]): string[] {
  const home = os.homedir();
  const norm = (p: string) => path.resolve(p).toLowerCase();
  const roots = comfyDirs.filter((d) => norm(d) !== norm(target));
  const bases = [home, path.join(home, "Documents"), path.join(home, "Desktop"), path.resolve(process.cwd(), "..")];
  for (const r of driveRoots()) bases.push(r, path.join(r, "AI"), path.join(r, "PROJECTS"), path.join(r, "Tools"));
  for (const base of bases) {
    try {
      for (const e of fs.readdirSync(/*turbopackIgnore: true*/ base)) {
        if (/stable-?diffusion|webui|forge|fooocus|sd\.?next|automatic1111|stabilitymatrix|invoke/i.test(e)) roots.push(path.join(base, e), path.join(base, e, "Data"));
      }
    } catch {
      // unreadable base
    }
  }
  roots.push(path.join(home, "Downloads"));
  return [...new Set(roots)];
}

const KIND_LABEL: Record<InstallKind, string> = { manual: "manual install", portable: "portable build", desktop: "ComfyUI Desktop" };

/** Everything setup needs to know about this machine, its ComfyUI and what is missing. */
export async function buildReport(): Promise<SetupReport & { port: number }> {
  const config = getConfig();
  const running = await findRunning(config.comfyUrl);
  const candidates = comfyCandidates();
  const chosen = (running?.baseDir && isComfyDir(running.baseDir) ? running.baseDir : "") || config.comfyPath || candidates[0] || "";
  const install = chosen ? describeInstall(chosen) : null;
  const vram = running ? running.vramTotal / GB : install?.gpuTorch ? await nvidiaVramGb() : 0;
  // A CUDA build without an NVIDIA driver cannot run on the GPU; on Linux ROCm has no nvidia-smi.
  const gpu = running ? running.device !== "cpu" : !!install?.gpuTorch && (!win || vram > 0);
  const profile = gpu && vram >= 11 ? "studio" : "lite";
  const ramTotal = running?.ramTotal ?? os.totalmem();
  const lowMemory = !gpu || ramTotal < 12 * GB;
  let port = running ? Number(new URL(running.url).port || 80) : 8188;
  if (!running) for (const p of PORTS) if (await portFree(p)) { port = p; break; }

  const roots = install ? localRoots(install.path, candidates) : [];
  const models = install
    ? setupModels(profile, lowMemory).map((m) => {
        const installed = isInstalled(install.path, m);
        const copy = installed || m.convertFrom ? null : findLocalCopy(m, roots, modelPath(install.path, m));
        return { id: m.id, name: m.name, bytes: m.bytes, installed, convert: !!m.convertFrom, localCopy: copy?.path ?? null };
      })
    : [];
  const nodes = install ? setupNodes(profile).map((n) => ({ id: n.id, name: n.name, installed: isNodePackInstalled(install.path, n) })) : [];
  let diskFree: number | null = null;
  try {
    if (install) {
      const st = fs.statfsSync(install.path);
      diskFree = st.bavail * st.bsize;
    }
  } catch {
    // statfs unsupported
  }
  return {
    config,
    install,
    others: candidates.filter((c) => !install || path.resolve(c).toLowerCase() !== path.resolve(install.path).toLowerCase()),
    running,
    gpu,
    profile,
    lowMemory,
    ramTotal,
    launchArgs: launchArgs({ gpu, port }),
    nodes,
    models,
    downloadBytes: models.filter((m) => !m.installed && !m.convert && !m.localCopy).reduce((s, m) => s + m.bytes, 0),
    diskFree,
    ready: !!install && !!running && !running.issues.length && nodes.every((n) => n.installed) && models.every((m) => m.installed),
    port,
  };
}

/** Saves the detected ComfyUI folder and URL so Strata and Model Manager use them. */
export async function applyDetected(): Promise<SetupReport> {
  const report = await buildReport();
  if (report.install) setConfig({ comfyPath: report.install.path, comfyUrl: report.running?.url ?? `http://127.0.0.1:${report.port}` });
  return { ...report, config: getConfig() };
}

function logTail(file: string, lines = 6): string {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-lines).join(" | ");
  } catch {
    return "";
  }
}

/**
 * Starts ComfyUI detached (it keeps running when Strata stops), with the flags this machine
 * needs, logging to .strata/comfyui.log, and waits until it answers.
 */
export async function startComfy(install: InstallInfo, port: number, gpu: boolean, isCancelled = () => false): Promise<RunningInfo> {
  if (!install.canStart || !install.python) {
    throw new Error(install.kind === "desktop" ? "This is a ComfyUI Desktop install: open the ComfyUI Desktop app and Strata connects to it." : "ComfyUI's Python environment (.venv, venv or python_embeded) was not found; start ComfyUI yourself.");
  }
  const portable = install.kind === "portable";
  const args = [...(portable ? ["-s", path.join("ComfyUI", "main.py")] : ["main.py"]), ...launchArgs({ gpu, port })];
  const log = path.join(strataDir(), "comfyui.log");
  const fd = fs.openSync(log, "a");
  fs.writeSync(fd, `\n=== ${new Date().toISOString()} Strata started: ${install.python} ${args.join(" ")}\n`);
  const child = spawn(install.python, args, {
    cwd: portable ? path.dirname(install.path) : install.path,
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  fs.closeSync(fd);
  let exited: number | null = null;
  child.on("exit", (code) => (exited = code ?? -1));
  child.on("error", () => (exited = -1));
  child.unref();
  const url = `http://127.0.0.1:${port}`;
  // Importing torch and loading custom nodes takes a minute or more on a busy CPU machine.
  for (const deadline = Date.now() + 300_000; Date.now() < deadline; ) {
    if (isCancelled()) throw new Error("Cancelled");
    if (exited !== null) throw new Error(`ComfyUI exited (code ${exited}) while starting: ${logTail(log)}`);
    const r = await inspect(url);
    if (r) return r;
    await sleep(2000);
  }
  throw new Error(`ComfyUI did not answer on port ${port} within 5 minutes; see .strata/comfyui.log.`);
}

async function listeningPid(port: number): Promise<number | null> {
  if (win) return pidFromNetstat((await exec("netstat", ["-ano", "-p", "TCP"], { windowsHide: true })).stdout, port);
  const { stdout } = await exec("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"]).catch(() => ({ stdout: "" }));
  return Number(stdout.trim().split(/\s+/)[0]) || null;
}

async function commandLine(pid: number): Promise<string> {
  if (win) {
    const { stdout } = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { windowsHide: true, timeout: 15_000 });
    return stdout.trim();
  }
  return (await exec("ps", ["-o", "args=", "-p", String(pid)])).stdout.trim();
}

/** Stops the local ComfyUI behind `url`, refusing while it has work queued. */
export async function stopComfy(url: string): Promise<void> {
  const info = await inspect(url);
  if (!info) return;
  if (!info.local) throw new Error("ComfyUI runs on another machine; restart it there.");
  if (info.queue > 0) throw new Error(`ComfyUI is busy (${info.queue} job${info.queue > 1 ? "s" : ""} queued). Restart it after they finish.`);
  const port = Number(new URL(url).port || 80);
  const pid = await listeningPid(port);
  if (!pid) throw new Error(`Could not find the process listening on port ${port}.`);
  const cmd = await commandLine(pid);
  // Never stop something that is not ComfyUI just because it holds the port.
  if (!/main\.py|comfy/i.test(cmd)) throw new Error(`Port ${port} belongs to another program; not stopping it.`);
  if (win) await exec("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  else process.kill(pid, "SIGTERM");
  for (const deadline = Date.now() + 30_000; Date.now() < deadline; await sleep(1000)) if (!(await inspect(url))) return;
  throw new Error("ComfyUI did not stop within 30 s.");
}

class StepError extends Error {}

const state = globalThis as unknown as { __strataSetup?: { view: SetupJobView; cancel: () => void } };

export function getSetupJob(): SetupJobView | null {
  return state.__strataSetup?.view ?? null;
}

export function cancelSetup() {
  state.__strataSetup?.cancel();
}

/**
 * One-click setup. `full`: find ComfyUI and save it, install missing node packs, start or
 * restart ComfyUI with the right flags, then install every missing model (identical local copies
 * first, then downloads, two at a time, checksum-verified) and run the low-memory conversions as
 * soon as their source is in place. `server`: only the start / restart.
 */
export function startSetup(scope: "full" | "server" = "full", opts: { restart?: boolean } = {}): SetupJobView {
  const current = state.__strataSetup?.view;
  if (current?.status === "running") return current;
  const all: SetupStep[] = [
    { id: "detect", label: "Find ComfyUI and this machine's hardware", status: "pending" },
    { id: "nodes", label: "Custom nodes", status: "pending" },
    { id: "server", label: "Start ComfyUI with the right flags", status: "pending" },
    { id: "models", label: "Models", status: "pending" },
    { id: "convert", label: "Low-memory copies", status: "pending" },
  ];
  const steps = scope === "full" ? all : all.filter((s) => s.id === "detect" || s.id === "server");
  const view: SetupJobView = { scope, status: "running", steps, startedAt: Date.now() };
  const started: string[] = [];
  let cancelled = false;
  state.__strataSetup = {
    view,
    cancel: () => {
      cancelled = true;
      started.forEach(cancelJob);
    },
  };
  const set = (id: SetupStep["id"], status: SetupStep["status"], detail?: string) => Object.assign(steps.find((s) => s.id === id)!, { status, detail });
  const checkCancel = () => {
    if (cancelled) throw new Error("Cancelled");
  };

  (async () => {
    set("detect", "running");
    const report = await buildReport();
    const install = report.install;
    if (!install) throw new StepError("ComfyUI was not found on this machine. Install ComfyUI (manual, portable or Desktop), or set its folder in Settings.");
    const comfyPath = install.path;
    let comfyUrl = report.running?.url ?? `http://127.0.0.1:${report.port}`;
    setConfig({ comfyPath, comfyUrl });
    set("detect", "done", `${comfyPath} · ${KIND_LABEL[install.kind]} · ${report.gpu ? "GPU" : "CPU"} · ${report.profile === "studio" ? "Studio" : "Lite"} profile`);
    checkCancel();

    let nodesChanged = false;
    if (scope === "full") {
      set("nodes", "running");
      const missing = setupNodes(report.profile).filter((n) => !isNodePackInstalled(comfyPath, n));
      for (const n of missing) {
        set("nodes", "running", `Installing ${n.name}`);
        const id = startNodeInstall(comfyPath, n).id;
        started.push(id);
        while (getJob(id)?.status === "running") await sleep(500);
        checkCancel();
        const j = getJob(id);
        if (j?.status !== "done") throw new StepError(`${n.name}: ${j?.error ?? "install failed"}`);
      }
      nodesChanged = missing.length > 0;
      set("nodes", "done", missing.length ? `Installed ${missing.map((n) => n.name).join(", ")}` : "All present");
    }

    // Start (or restart) early, so masks can be painted while models download; new model files
    // show up in ComfyUI without a restart, new node packs do not.
    set("server", "running");
    const shown = (args: string[]) => args.filter((a) => a !== "--listen" && a !== "127.0.0.1").join(" ");
    try {
      const running = await inspect(comfyUrl);
      if (!running && !install.canStart) {
        set("server", "skipped", install.kind === "desktop" ? "Open the ComfyUI Desktop app; Strata connects to it by itself." : "ComfyUI's Python environment was not found; start ComfyUI yourself.");
      } else if (!running) {
        set("server", "running", `Starting ComfyUI on port ${report.port} (${shown(report.launchArgs)}); this takes a minute or two`);
        const up = await startComfy(install, report.port, report.gpu, () => cancelled);
        comfyUrl = up.url;
        setConfig({ comfyUrl });
        set("server", "done", `Started at ${up.url} with ${shown(report.launchArgs)}`);
      } else if (running.local && (running.issues.length || nodesChanged || opts.restart)) {
        const why = running.issues.length ? `${running.issues.map((i) => i.flag).join(", ")} ${running.issues[0].problem}` : nodesChanged ? "load the new node packs" : "apply the recommended flags";
        if (!install.canStart) set("server", "skipped", `Restart ComfyUI yourself to ${why}.`);
        else if (running.queue > 0) set("server", "skipped", `ComfyUI is busy; restart it after the current job to ${why}.`);
        else {
          set("server", "running", `Restarting ComfyUI to ${why}`);
          await stopComfy(running.url);
          const port = Number(new URL(running.url).port || report.port);
          const up = await startComfy(install, port, report.gpu, () => cancelled);
          set("server", "done", `Restarted at ${up.url} with ${shown(launchArgs({ gpu: report.gpu, port }))}`);
        }
      } else {
        set("server", "done", `Running at ${running.url}${running.local ? "" : " (another machine)"}`);
      }
    } catch (e) {
      // Models can still be installed without a running ComfyUI; report and carry on.
      if (cancelled || scope === "server") throw e;
      set("server", "error", e instanceof Error ? e.message : String(e));
    }
    if (scope === "server") return;
    checkCancel();

    const plan = setupModels(report.profile, report.lowMemory).filter((m) => !isInstalled(comfyPath, m));
    const downloads = plan.filter((m) => !m.convertFrom);
    const conversions = plan.filter((m) => m.convertFrom);
    const needed = downloads.reduce((s, m) => s + m.bytes, 0) + conversions.length * 2 * GB;
    if (report.diskFree !== null && needed > report.diskFree - GB) {
      throw new StepError(`Not enough disk space on the ComfyUI drive: about ${formatBytes(needed)} needed, ${formatBytes(report.diskFree)} free.`);
    }
    const roots = localRoots(comfyPath, comfyCandidates());
    for (const m of downloads) started.push(startModelInstall(comfyPath, m, { localRoots: roots }).id);
    set("models", downloads.length ? "running" : "done", downloads.length ? "Starting" : "All present");
    set("convert", conversions.length ? "pending" : report.lowMemory ? "done" : "skipped", conversions.length ? "Waiting for their source models" : report.lowMemory ? "All present" : "Not needed on this machine");

    const queue = [...conversions];
    const source = (m: CatalogModel) => MODEL_CATALOG.find((x) => x.id === m.convertFrom)!;
    let active: CatalogModel | null = null;
    const convertErrors: string[] = [];
    for (;;) {
      checkCancel();
      const rows = downloads.map((m) => ({ m, j: getJob(m.id) }));
      const busy = rows.filter((r) => r.j?.status === "running");
      const failed = rows.filter((r) => r.j && r.j.status !== "running" && r.j.status !== "done");
      if (downloads.length) {
        const done = rows.filter((r) => r.j?.status === "done").length;
        const left = rows.filter((r) => r.j?.status !== "done").reduce((s, r) => s + r.m.bytes - (r.j?.phase === "download" ? r.j.received : 0), 0);
        const speed = busy.reduce((s, r) => s + (r.j?.phase === "download" ? r.j.speed : 0), 0);
        const parts = [`${done} of ${downloads.length} installed`];
        if (busy.length && left > 0) parts.push(`${formatBytes(left)} left`);
        if (speed > 0) parts.push(`${formatBytes(speed)}/s, about ${formatDuration(left / speed)}`);
        if (failed.length) parts.push(`failed: ${failed.map((r) => `${r.m.name} (${r.j?.error ?? r.j?.status})`).join("; ")}`);
        set("models", busy.length ? "running" : failed.length ? "error" : "done", parts.join(" · "));
      }
      if (active && getJob(active.id)?.status !== "running") {
        if (getJob(active.id)?.status !== "done") convertErrors.push(`${active.name}: ${getJob(active.id)?.error ?? "failed"}`);
        active = null;
      }
      // One conversion at a time: each holds a model's tensors in memory.
      if (!active) {
        const next = queue.find((c) => isInstalled(comfyPath, source(c)));
        if (next) {
          queue.splice(queue.indexOf(next), 1);
          active = next;
          started.push(startModelInstall(comfyPath, next).id);
        }
      }
      // A conversion whose source failed to download can never start.
      const stuck = busy.length ? [] : queue.filter((c) => !isInstalled(comfyPath, source(c)));
      for (const c of stuck) {
        queue.splice(queue.indexOf(c), 1);
        convertErrors.push(`${c.name}: needs ${source(c).name}`);
      }
      if (conversions.length) {
        const done = conversions.filter((c) => isInstalled(comfyPath, c)).length;
        const status = active || queue.length ? "running" : convertErrors.length ? "error" : "done";
        set("convert", status, [`${done} of ${conversions.length} made`, active && `converting ${active.name}`, convertErrors.length && `failed: ${convertErrors.join("; ")}`].filter(Boolean).join(" · "));
      }
      if (!busy.length && !active && !queue.length) break;
      await sleep(1000);
    }
  })()
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      const runningStep = steps.find((s) => s.status === "running");
      if (cancelled) {
        view.status = "cancelled";
        if (runningStep) Object.assign(runningStep, { status: "error", detail: "Cancelled" });
        return;
      }
      if (runningStep) Object.assign(runningStep, { status: "error", detail: msg });
      view.error = msg;
    })
    .finally(() => {
      for (const s of steps) if (s.status === "pending") s.status = "skipped";
      if (view.status === "running") {
        const failed = steps.filter((s) => s.status === "error");
        view.status = failed.length ? "error" : "done";
        if (failed.length && !view.error) view.error = failed.map((s) => `${s.label}: ${s.detail}`).join(" · ");
      }
      view.finishedAt = Date.now();
    });
  return view;
}
