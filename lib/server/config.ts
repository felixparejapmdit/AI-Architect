import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface StrataConfig {
  comfyUrl: string;
  /** ComfyUI base folder (contains models/ and custom_nodes/, and main.py except for ComfyUI Desktop). */
  comfyPath: string;
}

const CONFIG_DIR = path.join(process.cwd(), ".strata");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export function strataDir(): string {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  return CONFIG_DIR;
}

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** A ComfyUI base folder: models/ plus main.py (manual / portable) or custom_nodes/ (Desktop's base path). */
export function isComfyDir(dir: string): boolean {
  return isDir(path.join(dir, "models")) && (fs.existsSync(path.join(dir, "main.py")) || isDir(path.join(dir, "custom_nodes")));
}

/** ComfyUI Desktop keeps its base path (models, custom_nodes, .venv) in %APPDATA%\ComfyUI\config.json. */
function desktopBasePath(): string | null {
  const appData = process.env.APPDATA ?? (process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support") : path.join(os.homedir(), ".config"));
  try {
    const j = JSON.parse(fs.readFileSync(path.join(appData, "ComfyUI", "config.json"), "utf8")) as { basePath?: string };
    return j.basePath ?? null;
  } catch {
    return null;
  }
}

export function driveRoots(): string[] {
  if (process.platform !== "win32") return ["/", "/opt", "/srv"];
  return "CDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((l) => `${l}:\\`).filter((r) => isDir(r));
}

/**
 * Every ComfyUI folder found on this machine, most likely first: the env override, ComfyUI
 * Desktop's base path, Strata's siblings, then the usual spots on each drive, plus any folder
 * named ComfyUI* one level down in those spots.
 */
export function comfyCandidates(): string[] {
  const home = os.homedir();
  const bases = [home, path.join(home, "Documents"), path.join(home, "Desktop"), path.resolve(process.cwd(), "..")];
  for (const root of driveRoots()) bases.push(root, path.join(root, "AI"), path.join(root, "PROJECTS"), path.join(root, "Programs"), path.join(root, "Tools"));
  const out: string[] = [];
  const add = (p: string | null | undefined) => {
    if (p && !out.some((x) => path.resolve(x).toLowerCase() === path.resolve(p).toLowerCase()) && isComfyDir(p)) out.push(path.resolve(p));
  };
  add(process.env.COMFYUI_PATH);
  add(desktopBasePath());
  for (const base of bases) {
    let entries: string[] = [];
    try {
      // A machine scan, not project files: keep it out of Next's output file tracing.
      entries = fs.readdirSync(/*turbopackIgnore: true*/ base).filter((e) => /^comfy/i.test(e));
    } catch {
      continue;
    }
    for (const e of entries) {
      add(path.join(base, e));
      add(path.join(base, e, "ComfyUI"));
    }
  }
  return out;
}

// getConfig() runs on every proxied request; rescan the disk at most once a minute.
const detected = globalThis as unknown as { __strataDetected?: { at: number; path: string } };

export function detectComfyPath(): string {
  const c = detected.__strataDetected;
  if (c && Date.now() - c.at < 60_000) return c.path;
  const found = comfyCandidates()[0] ?? "";
  detected.__strataDetected = { at: Date.now(), path: found };
  return found;
}

export function getConfig(): StrataConfig {
  let saved: Partial<StrataConfig> = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    // first run
  }
  return {
    comfyUrl: (saved.comfyUrl || process.env.COMFYUI_URL || "http://127.0.0.1:8188").replace(/\/+$/, ""),
    comfyPath: saved.comfyPath && isComfyDir(saved.comfyPath) ? saved.comfyPath : detectComfyPath(),
  };
}

export function setConfig(patch: Partial<StrataConfig>): StrataConfig {
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const next = { ...getConfig(), ...defined };
  next.comfyUrl = next.comfyUrl.replace(/\/+$/, "");
  const url = new URL(next.comfyUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("ComfyUI URL must be http(s).");
  if (next.comfyPath && !isComfyDir(next.comfyPath)) throw new Error(`"${next.comfyPath}" is not a ComfyUI folder (no models/ with main.py or custom_nodes/).`);
  fs.writeFileSync(path.join(strataDir(), "config.json"), JSON.stringify(next, null, 2));
  return next;
}
