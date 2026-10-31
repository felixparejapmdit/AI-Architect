import type { PipelineProfile } from "./types";

/** Types and pure helpers shared by the setup API (server) and the setup panel (browser). */

export type InstallKind = "manual" | "portable" | "desktop";

export interface InstallInfo {
  /** ComfyUI base folder: holds models/ and custom_nodes/. */
  path: string;
  /** manual = git/zip install with its own venv; portable = Windows standalone; desktop = ComfyUI Desktop app. */
  kind: InstallKind;
  python: string | null;
  /** PyTorch build: true = CUDA/ROCm, false = CPU-only, null = not found. */
  gpuTorch: boolean | null;
  /** Strata can launch this install itself (the Desktop app manages its own server). */
  canStart: boolean;
}

export interface ArgvIssue {
  flag: string;
  problem: string;
}

export interface RunningInfo {
  url: string;
  version: string;
  device: string;
  vramTotal: number;
  ramTotal: number;
  argv: string[];
  issues: ArgvIssue[];
  /** Base folder ComfyUI reports for its models (null when it does not say). */
  baseDir: string | null;
  /** Jobs running or waiting. */
  queue: number;
  /** Strata can restart it (local, and the process is ComfyUI). */
  local: boolean;
}

export interface SetupModelRow {
  id: string;
  name: string;
  bytes: number;
  installed: boolean;
  /** Made locally from another model instead of downloaded. */
  convert: boolean;
  /** A verified-size copy elsewhere on disk that setup links instead of downloading. */
  localCopy: string | null;
}

export interface SetupReport {
  config: { comfyUrl: string; comfyPath: string };
  install: InstallInfo | null;
  /** Other ComfyUI folders found on this machine. */
  others: string[];
  running: RunningInfo | null;
  /** Renders will run on an NVIDIA/AMD GPU. */
  gpu: boolean;
  profile: PipelineProfile;
  lowMemory: boolean;
  ramTotal: number;
  /** Arguments Strata starts ComfyUI with, after main.py. */
  launchArgs: string[];
  nodes: { id: string; name: string; installed: boolean }[];
  models: SetupModelRow[];
  /** Bytes still to fetch from the internet (local copies and conversions excluded). */
  downloadBytes: number;
  diskFree: number | null;
  ready: boolean;
}

export type StepStatus = "pending" | "running" | "done" | "skipped" | "error";

export interface SetupStep {
  id: "detect" | "nodes" | "server" | "models" | "convert";
  label: string;
  status: StepStatus;
  detail?: string;
}

export interface SetupJobView {
  /** "full" = one-click setup; "server" = start / restart ComfyUI only. */
  scope: "full" | "server";
  status: "running" | "done" | "error" | "cancelled";
  steps: SetupStep[];
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

/**
 * Launch flags that break Strata on this device. On CPU every global dtype flag breaks
 * something: --fp16/--bf16-unet makes IP-Adapter fail with a dtype mismatch, and a global fp8
 * flag also stores SAM3 in fp8, which has no CPU convolution. Strata stores the render UNet in
 * fp8 per model instead.
 */
export function argvIssues(argv: string[], device: string): ArgvIssue[] {
  if (device !== "cpu") return [];
  const issues: ArgvIssue[] = [];
  for (const a of argv) {
    if (/^--(fp16|bf16)-unet$/.test(a)) issues.push({ flag: a, problem: "breaks IP-Adapter on CPU (fp16/fp32 mismatch)" });
    if (/^--fp8_e(4m3fn|5m2)-unet$/.test(a)) issues.push({ flag: a, problem: "breaks SAM3 Auto-detect on CPU (no fp8 convolutions)" });
  }
  return issues;
}

/** Arguments after main.py for a ComfyUI that Strata starts. */
export function launchArgs(opts: { gpu: boolean; port: number }): string[] {
  return ["--listen", "127.0.0.1", "--port", String(opts.port), "--disable-auto-launch", ...(opts.gpu ? [] : ["--cpu"])];
}

/**
 * Reads torch/version.py: `cuda: Optional[str] = '12.4'` (or `hip = '6.2'` on ROCm) means a GPU
 * build, `= None` for both means CPU-only. Null when the file is not a torch version file.
 */
export function torchHasGpu(versionPy: string): boolean | null {
  const field = (name: string) => new RegExp(`^${name}(?:\\s*:[^=\\n]*)?\\s*=\\s*(None|'[^']*'|"[^"]*")`, "m").exec(versionPy)?.[1];
  const cuda = field("cuda");
  const hip = field("hip");
  if (cuda === undefined && hip === undefined) return null;
  return (cuda !== undefined && cuda !== "None") || (hip !== undefined && hip !== "None");
}

/** ComfyUI's /internal/folder_paths lists each model folder; its base is two levels above models/checkpoints. */
export function baseDirFromFolderPaths(paths: Record<string, unknown>, sep = "/"): string | null {
  const first = (paths.checkpoints as string[] | undefined)?.[0];
  if (!first) return null;
  const parts = first.split(/[\\/]+/);
  if (parts.length < 3 || parts.at(-2)?.toLowerCase() !== "models") return null;
  const base = parts.slice(0, -2).join(sep);
  // "C:" alone is a drive-relative path; keep the root separator.
  return /^[A-Za-z]:$/.test(base) ? base + sep : base;
}

/** PID listening on 127.0.0.1/0.0.0.0:<port> in `netstat -ano` output (Windows). */
export function pidFromNetstat(out: string, port: number): number | null {
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (m && Number(m[2]) === port) return Number(m[3]);
  }
  return null;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 90) return `${Math.ceil(seconds)} s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}
