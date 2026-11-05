import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { MODEL_CATALOG, type CatalogModel, type CustomNodePack } from "../models-catalog";

export interface Job {
  id: string;
  kind: "model" | "node";
  status: "running" | "done" | "error" | "cancelled";
  received: number;
  total: number;
  /** Bytes per second, smoothed. */
  speed: number;
  /** What the bytes are: an internet download, a copy from this machine, or a checksum read. */
  phase?: "download" | "copy" | "verify";
  error?: string;
  log: string[];
  startedAt: number;
  abort?: () => void;
}

// Survive dev-server hot reloads.
const g = globalThis as unknown as { __strataJobs?: Map<string, Job> };
const jobs = (g.__strataJobs ??= new Map());

export function getJob(id: string): Omit<Job, "abort"> | undefined {
  const j = jobs.get(id);
  if (!j) return undefined;
  const { abort: _abort, ...rest } = j;
  return { ...rest, log: rest.log.slice(-12) };
}

export function modelPath(comfyPath: string, m: CatalogModel) {
  return path.join(comfyPath, "models", m.dir, m.filename);
}

/** Bytes already on disk from an interrupted download (0 if none). */
export function partialBytes(comfyPath: string, m: CatalogModel): number {
  if (!comfyPath) return 0;
  try {
    return fs.statSync(modelPath(comfyPath, m) + ".part").size;
  } catch {
    return 0;
  }
}

export function isInstalled(comfyPath: string, m: CatalogModel): boolean {
  if (!comfyPath) return false;
  try {
    const st = fs.statSync(modelPath(comfyPath, m));
    return st.size > 0 && (!m.bytes || st.size === m.bytes);
  } catch {
    return false;
  }
}

const formatMb = (n: number) => `${(n / 1e6).toFixed(0)} MB`;
const MAX_PARALLEL = 2;
const MAX_ATTEMPTS = 6;
const queue: (() => void)[] = [];
let active = 0;

function schedule(task: () => Promise<void>) {
  const run = () => {
    active++;
    task().finally(() => {
      active--;
      queue.shift()?.();
    });
  };
  if (active < MAX_PARALLEL) run();
  else queue.push(run);
}

/** One HTTP attempt: appends to `part` from its current size. */
async function fetchInto(url: string, part: string, job: Job, signal: AbortSignal) {
  const resumeFrom = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const res = await fetch(url, { headers: resumeFrom ? { Range: `bytes=${resumeFrom}-` } : {}, signal, redirect: "follow" });
  if (res.status === 416) return; // already complete
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  const resumed = res.status === 206;
  job.received = resumed ? resumeFrom : 0;
  const len = Number(res.headers.get("content-length") || 0);
  if (len) job.total = job.received + len;

  const out = fs.createWriteStream(part, { flags: resumed ? "a" : "w" });
  let windowStart = Date.now();
  let windowBytes = 0;
  const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  body.on("data", (chunk: Buffer) => {
    job.received += chunk.length;
    windowBytes += chunk.length;
    const dt = Date.now() - windowStart;
    if (dt > 1000) {
      const now = (windowBytes / dt) * 1000;
      job.speed = job.speed ? job.speed * 0.6 + now * 0.4 : now;
      windowStart = Date.now();
      windowBytes = 0;
    }
  });
  await new Promise<void>((resolve, reject) => {
    body.pipe(out);
    out.on("finish", resolve);
    out.on("error", reject);
    body.on("error", (e) => {
      out.end();
      reject(e);
    });
  });
}

/** SHA-256 of a file, streamed; reports bytes read so long checks show progress. */
export async function sha256File(file: string, onBytes?: (n: number) => void, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 << 20 })) {
    if (signal?.aborted) throw new Error("aborted");
    hash.update(chunk as Buffer);
    onBytes?.((chunk as Buffer).length);
  }
  return hash.digest("hex");
}

const sizeOf = (p: string) => {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st.size : -1;
  } catch {
    return -1;
  }
};

/** Hugging Face hub caches. Their LFS blobs are named by SHA-256, so a match needs no hashing. */
function hfHubCaches(): string[] {
  const home = os.homedir();
  return [process.env.HF_HUB_CACHE, process.env.HF_HOME && path.join(process.env.HF_HOME, "hub"), path.join(home, ".cache", "huggingface", "hub")].filter((p): p is string => !!p);
}

// File name (lower case) → paths, for model-sized files under other installs' model folders.
const g2 = globalThis as unknown as { __strataLocalIndex?: { at: number; key: string; files: Map<string, string[]> } };

/**
 * Indexes model files (>1 MB) under `roots`: each root's models/ and extensions/ folders (ComfyUI,
 * A1111/Forge) or the root itself (Downloads), a few levels deep and capped so a huge drive
 * cannot stall setup. Cached for a minute.
 */
function localIndex(roots: string[]): Map<string, string[]> {
  const key = roots.join("|");
  const cached = g2.__strataLocalIndex;
  if (cached && cached.key === key && Date.now() - cached.at < 60_000) return cached.files;
  const files = new Map<string, string[]>();
  let budget = 30_000;
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (--budget < 0) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth > 0 && !e.name.startsWith(".")) walk(p, depth - 1);
      else if (e.isFile() && /\.(safetensors|pth|bin|ckpt)$/i.test(e.name)) {
        const k = e.name.toLowerCase();
        files.set(k, [...(files.get(k) ?? []), p]);
      }
    }
  };
  for (const root of roots) {
    const models = path.join(root, "models");
    if (fs.existsSync(models)) {
      walk(models, 3);
      walk(path.join(root, "extensions"), 3);
    } else {
      walk(root, 1);
    }
  }
  g2.__strataLocalIndex = { at: Date.now(), key, files };
  return files;
}

/**
 * An existing copy of a catalogue model on this machine: a Hugging Face cache blob with the same
 * SHA-256, or a file with the same name and exact size in another install. Same-size copies are
 * hashed before use, so a different file that happens to share a name is never installed.
 */
export function findLocalCopy(m: CatalogModel, roots: string[], exclude: string): { path: string; trusted: boolean } | null {
  if (!m.url || !m.bytes) return null;
  if (m.sha256) {
    for (const hub of hfHubCaches()) {
      let repos: string[] = [];
      try {
        repos = fs.readdirSync(hub).filter((r) => r.startsWith("models--"));
      } catch {
        continue;
      }
      for (const repo of repos) {
        const blob = path.join(hub, repo, "blobs", m.sha256);
        if (sizeOf(blob) === m.bytes) return { path: blob, trusted: true };
      }
    }
  }
  const skip = path.resolve(exclude).toLowerCase();
  for (const p of localIndex(roots).get(m.filename.toLowerCase()) ?? []) {
    if (path.resolve(p).toLowerCase() !== skip && sizeOf(p) === m.bytes) return { path: p, trusted: false };
  }
  return null;
}

/** Hard link when on the same drive (instant, no extra space), else a streamed copy. */
async function placeLocalCopy(src: string, dest: string, job: Job, signal: AbortSignal) {
  try {
    fs.linkSync(src, dest);
    job.log.push(`Linked the copy at ${src} (same drive: no download, no extra space)`);
    return;
  } catch {
    // another drive, or a file system without hard links
  }
  job.phase = "copy";
  job.received = 0;
  job.log.push(`Copying from ${src}`);
  const part = dest + ".part";
  const input = fs.createReadStream(src, { highWaterMark: 4 << 20 });
  input.on("data", (c) => (job.received += c.length));
  await pipeline(input, fs.createWriteStream(part), { signal });
  fs.renameSync(part, dest);
}

/** Checks a file against the catalogue hash; throws (after deleting a bad download) on mismatch. */
async function verify(m: CatalogModel, file: string, job: Job, signal: AbortSignal, deleteOnMismatch: boolean) {
  if (!m.sha256) return;
  job.phase = "verify";
  job.received = 0;
  job.speed = 0;
  job.log.push("Verifying checksum");
  const digest = await sha256File(file, (n) => (job.received += n), signal);
  if (digest !== m.sha256) {
    if (deleteOnMismatch) fs.rmSync(file, { force: true });
    throw new Error(`Checksum mismatch for ${path.basename(file)}${deleteOnMismatch ? " (corrupted download removed; click Download to fetch it again)" : ""}.`);
  }
}

export interface InstallOptions {
  /** Folders to look in for an existing copy before downloading. */
  localRoots?: string[];
}

/**
 * Installs a catalogue model into ComfyUI/models/<dir>: from an identical copy already on this
 * machine when there is one, otherwise by streaming it from Hugging Face. Runs two at a time,
 * retries dropped connections from the .part file, and checks the SHA-256 before installing.
 */
export function startModelDownload(comfyPath: string, m: CatalogModel, opts: InstallOptions = {}): Job {
  const existing = jobs.get(m.id);
  if (existing?.status === "running") return existing;
  const dest = modelPath(comfyPath, m);
  const part = dest + ".part";
  const controller = new AbortController();
  const job: Job = { id: m.id, kind: "model", status: "running", received: 0, total: m.bytes, speed: 0, phase: "download", log: ["Queued"], startedAt: Date.now(), abort: () => controller.abort() };
  jobs.set(m.id, job);

  schedule(async () => {
    try {
      if (controller.signal.aborted) throw new Error("aborted");
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const local = opts.localRoots ? findLocalCopy(m, opts.localRoots, dest) : null;
      if (local) {
        try {
          if (!local.trusted) await verify(m, local.path, job, controller.signal, false);
          await placeLocalCopy(local.path, dest, job, controller.signal);
          job.received = job.total = m.bytes;
          job.status = "done";
          return;
        } catch (e) {
          if (controller.signal.aborted) throw e;
          job.log.push(`Local copy not usable (${e instanceof Error ? e.message : e}); downloading instead`);
          job.phase = "download";
        }
      }
      job.log.push("Downloading");
      // Give up only after MAX_ATTEMPTS consecutive drops that made no progress; a slow but
      // flaky link keeps resuming for as long as bytes keep arriving.
      for (let attempt = 1; ; attempt++) {
        const before = fs.existsSync(part) ? fs.statSync(part).size : 0;
        try {
          await fetchInto(m.url, part, job, controller.signal);
          break;
        } catch (e) {
          if (controller.signal.aborted) throw e;
          const after = fs.existsSync(part) ? fs.statSync(part).size : 0;
          if (after > before) attempt = 0;
          else if (attempt >= MAX_ATTEMPTS) throw e;
          job.speed = 0;
          job.log.push(`Connection dropped (${e instanceof Error ? e.message : e}); resuming from ${formatMb(after)}`);
          await new Promise((r) => setTimeout(r, 1500 * Math.max(1, attempt)));
        }
      }
      const size = fs.statSync(part).size;
      if (m.bytes && size !== m.bytes) throw new Error(`Size mismatch: got ${size}, expected ${m.bytes}. Retry to resume.`);
      await verify(m, part, job, controller.signal, true);
      fs.renameSync(part, dest);
      job.received = job.total = size;
      job.status = "done";
    } catch (e) {
      if (controller.signal.aborted) {
        job.status = "cancelled";
      } else {
        job.status = "error";
        job.error = e instanceof Error ? e.message : String(e);
      }
    }
  });
  return job;
}

export function cancelJob(id: string) {
  jobs.get(id)?.abort?.();
}

/** Python that runs this ComfyUI: portable, venv, or .venv. */
/**
 * A venv's python.exe is only a launcher for the interpreter named by `home` in pyvenv.cfg. A venv
 * copied from another machine or user keeps the launcher but points at a folder that is not here.
 */
function venvHomeExists(python: string): boolean {
  try {
    const cfg = fs.readFileSync(path.join(path.dirname(path.dirname(python)), "pyvenv.cfg"), "utf8");
    const home = /^home\s*=\s*(.+?)\s*$/m.exec(cfg)?.[1];
    return !home || fs.existsSync(home);
  } catch {
    return true; // no pyvenv.cfg: not a venv (python_embeded)
  }
}

export function findComfyPython(comfyPath: string): string | null {
  const win = process.platform === "win32";
  const candidates = win
    ? [path.join(comfyPath, ".venv", "Scripts", "python.exe"), path.join(comfyPath, "venv", "Scripts", "python.exe"), path.join(comfyPath, "..", "python_embeded", "python.exe")]
    : [path.join(comfyPath, ".venv", "bin", "python"), path.join(comfyPath, "venv", "bin", "python")];
  return candidates.find((p) => fs.existsSync(p) && venvHomeExists(p)) ?? null;
}

function run(job: Job, cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Inline scripts and full paths would flood the log panel; show their short forms.
    job.log.push(`$ ${path.basename(cmd)} ${args.map((a) => (a.includes("\n") ? "<script>" : path.basename(a))).join(" ")}`);
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    job.abort = () => child.kill();
    const onData = (d: Buffer) => job.log.push(...d.toString().split(/\r?\n/).filter(Boolean).slice(-4));
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited with ${code}`))));
  });
}

// Streams tensors one at a time so peak memory is ~1x the fp16 output, not fp32 + fp16 together.
const FP16_CONVERT = `
import os, sys
from safetensors import safe_open
from safetensors.torch import save_file
src, dst = sys.argv[1], sys.argv[2]
out = {}
with safe_open(src, framework="pt") as f:
    for key in f.keys():
        t = f.get_tensor(key)
        out[key] = t.half() if t.is_floating_point() else t
        del t
save_file(out, dst + ".part", metadata={"converted_by": "strata", "source": os.path.basename(src)})
os.replace(dst + ".part", dst)
print("wrote", dst, os.path.getsize(dst))
`;

// Copies the tensors under one key prefix (e.g. the UNet inside a checkpoint) into their own file.
const EXTRACT_PREFIX = `
import os, sys
from safetensors import safe_open
from safetensors.torch import save_file
src, dst, prefix = sys.argv[1], sys.argv[2], sys.argv[3]
out = {}
with safe_open(src, framework="pt") as f:
    for key in f.keys():
        if key.startswith(prefix):
            out[key[len(prefix):]] = f.get_tensor(key)
if not out:
    raise SystemExit("no tensors under " + prefix)
save_file(out, dst + ".part", metadata={"converted_by": "strata", "source": os.path.basename(src)})
os.replace(dst + ".part", dst)
print("wrote", len(out), "tensors to", dst)
`;

// Downloads a GitHub zip and moves its single top-level folder to the target directory.
const ZIP_INSTALL = `
import io, os, shutil, sys, tempfile, urllib.request, zipfile
url, dst = sys.argv[1], sys.argv[2]
data = urllib.request.urlopen(url, timeout=120).read()
tmp = tempfile.mkdtemp()
zipfile.ZipFile(io.BytesIO(data)).extractall(tmp)
(top,) = os.listdir(tmp)
shutil.move(os.path.join(tmp, top), dst)
print("extracted to", dst)
`;

const CONVERSIONS: Record<NonNullable<CatalogModel["convert"]>, { script: string; args: string[] }> = {
  fp16: { script: FP16_CONVERT, args: [] },
  "extract-unet": { script: EXTRACT_PREFIX, args: ["model.diffusion_model."] },
  "extract-clip": { script: EXTRACT_PREFIX, args: ["cond_stage_model.transformer."] },
};

/** Builds a derived catalogue model (fp16 copy, or a part of a checkpoint) with this ComfyUI's own Python. */
export function startConversion(comfyPath: string, target: CatalogModel, source: CatalogModel): Job {
  const existing = jobs.get(target.id);
  if (existing?.status === "running") return existing;
  const job: Job = { id: target.id, kind: "model", status: "running", received: 0, total: 0, speed: 0, log: ["Converting"], startedAt: Date.now() };
  jobs.set(target.id, job);
  (async () => {
    if (!isInstalled(comfyPath, source)) throw new Error(`Install "${source.name}" first.`);
    const py = findComfyPython(comfyPath);
    if (!py) throw new Error("Could not find ComfyUI's Python.");
    // e.g. models/diffusion_models or models/text_encoders may not exist yet in a fresh install.
    fs.mkdirSync(path.dirname(modelPath(comfyPath, target)), { recursive: true });
    const { script, args } = CONVERSIONS[target.convert ?? "fp16"];
    await run(job, py, ["-c", script, modelPath(comfyPath, source), modelPath(comfyPath, target), ...args], comfyPath);
    job.status = "done";
  })().catch((e: unknown) => {
    job.status = "error";
    job.error = e instanceof Error ? e.message : String(e);
  });
  return job;
}

/** Downloads (or links) a catalogue model, or builds it locally when it is a conversion. */
export function startModelInstall(comfyPath: string, m: CatalogModel, opts: InstallOptions = {}): Job {
  if (!m.convertFrom) return startModelDownload(comfyPath, m, opts);
  return startConversion(comfyPath, m, MODEL_CATALOG.find((x) => x.id === m.convertFrom)!);
}

export function nodePackDir(comfyPath: string, pack: CustomNodePack): string {
  return path.join(comfyPath, "custom_nodes", pack.repo.split("/").pop()!);
}

export function isNodePackInstalled(comfyPath: string, pack: CustomNodePack): boolean {
  return !!comfyPath && fs.existsSync(path.join(nodePackDir(comfyPath, pack), "__init__.py"));
}

/** git clone + pip install -r requirements.txt into this ComfyUI's own Python. */
export function startNodeInstall(comfyPath: string, pack: CustomNodePack): Job {
  const id = `node:${pack.id}`;
  const existing = jobs.get(id);
  if (existing?.status === "running") return existing;
  const job: Job = { id, kind: "node", status: "running", received: 0, total: 0, speed: 0, log: [], startedAt: Date.now() };
  jobs.set(id, job);
  const dir = nodePackDir(comfyPath, pack);

  (async () => {
    if (!fs.existsSync(dir)) {
      try {
        await run(job, "git", ["clone", "--depth", "1", "--recursive", pack.repo, dir], path.join(comfyPath, "custom_nodes"));
      } catch (e) {
        // No Git on this machine: fetch the default branch as a zip with ComfyUI's own Python.
        if ((e as NodeJS.ErrnoException).code !== "ENOENT" || pack.submodules) throw e;
        const py = findComfyPython(comfyPath);
        if (!py) throw new Error("Git is not installed and ComfyUI's Python was not found. Install Git, then retry.");
        job.log.push("Git not found; downloading the repository as a zip.");
        await run(job, py, ["-c", ZIP_INSTALL, `${pack.repo}/archive/HEAD.zip`, dir], path.join(comfyPath, "custom_nodes"));
      }
    } else job.log.push("Already cloned; checking requirements.");
    const req = path.join(dir, "requirements.txt");
    if (fs.existsSync(req)) {
      const py = findComfyPython(comfyPath);
      if (!py) throw new Error("Could not find ComfyUI's Python to install requirements; run pip manually.");
      await run(job, py, ["-m", "pip", "install", "-r", req], dir);
    }
    job.log.push("Installed. Restart ComfyUI to load the new nodes.");
    job.status = "done";
  })().catch((e: unknown) => {
    job.status = "error";
    job.error = e instanceof Error ? e.message : String(e);
  });
  return job;
}
