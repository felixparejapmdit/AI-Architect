import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { argvIssues, baseDirFromFolderPaths, launchArgs, pidFromNetstat, torchHasGpu } from "../lib/setup-shared";
import { MODEL_CATALOG, setupModels, setupNodes, type CatalogModel } from "../lib/models-catalog";
import { findLocalCopy, sha256File } from "../lib/server/downloads";
import { describeInstall } from "../lib/server/setup";
import { isComfyDir } from "../lib/server/config";

test("launch flags: global dtype flags are problems on CPU only", () => {
  const issues = argvIssues(["main.py", "--cpu", "--fp16-unet"], "cpu");
  assert.equal(issues.length, 1);
  assert.match(issues[0].problem, /IP-Adapter/);
  assert.match(argvIssues(["main.py", "--fp8_e4m3fn-unet"], "cpu")[0].problem, /SAM3/);
  assert.deepEqual(argvIssues(["main.py", "--fp16-unet"], "cuda"), []);
  assert.deepEqual(argvIssues(["main.py", "--cpu", "--listen", "127.0.0.1"], "cpu"), []);
});

test("launch args: --cpu without a GPU, local-only, no browser pop-up", () => {
  assert.deepEqual(launchArgs({ gpu: false, port: 8188 }), ["--listen", "127.0.0.1", "--port", "8188", "--disable-auto-launch", "--cpu"]);
  assert.ok(!launchArgs({ gpu: true, port: 8000 }).includes("--cpu"));
});

test("torch build detection reads torch/version.py", () => {
  assert.equal(torchHasGpu("__version__ = '2.7.0+cpu'\ncuda: Optional[str] = None\nhip: Optional[str] = None\n"), false);
  assert.equal(torchHasGpu("__version__ = '2.7.0+cu128'\ncuda: Optional[str] = '12.8'\nhip: Optional[str] = None\n"), true);
  assert.equal(torchHasGpu("cuda = None\nhip = '6.2.41133'\n"), true);
  assert.equal(torchHasGpu("print('not torch')"), null);
});

test("ComfyUI base folder from /internal/folder_paths", () => {
  assert.equal(baseDirFromFolderPaths({ checkpoints: ["D:\\PROJECTS\\ComfyUI\\models\\checkpoints"] }, "\\"), "D:\\PROJECTS\\ComfyUI");
  assert.equal(baseDirFromFolderPaths({ checkpoints: ["/home/a/ComfyUI/models/checkpoints", "/mnt/x"] }), "/home/a/ComfyUI");
  assert.equal(baseDirFromFolderPaths({ checkpoints: ["C:\\models\\checkpoints"] }, "\\"), "C:\\");
  assert.equal(baseDirFromFolderPaths({ checkpoints: ["/srv/ckpts"] }), null);
  assert.equal(baseDirFromFolderPaths({}), null);
});

test("the PID listening on a port is read from netstat -ano", () => {
  const out = [
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1012",
    "  TCP    127.0.0.1:4787         0.0.0.0:0              LISTENING       23532",
    "  TCP    127.0.0.1:8188         0.0.0.0:0              LISTENING       9120",
    "  TCP    127.0.0.1:8188         127.0.0.1:51000        ESTABLISHED     9120",
  ].join("\r\n");
  assert.equal(pidFromNetstat(out, 8188), 9120);
  assert.equal(pidFromNetstat(out, 8189), null);
});

test("setup installs everything Lite renders with; conversions only on low-memory hosts", () => {
  const ids = (ms: CatalogModel[]) => ms.map((m) => m.id);
  const cpu = ids(setupModels("lite", true));
  for (const id of ["rv51", "vae-ft-mse", "lcm-sd15", "cn-depth-sd15", "da3-small", "ipa-plus-sd15", "clip-vision-h", "sam3", "ultrasharp", "rv51-unet", "rv51-clip", "clip-vision-h-fp16"]) assert.ok(cpu.includes(id), id);
  const big = ids(setupModels("lite", false));
  assert.ok(!big.includes("rv51-unet") && !big.includes("clip-vision-h-fp16"));
  // The split UNet needs the VAE (fresh installs used to miss it and fall back to fp32).
  assert.ok(big.includes("vae-ft-mse"));
  assert.ok(ids(setupModels("studio", false)).includes("realvisxl5"));
  assert.ok(!ids(setupModels("studio", false)).includes("rv51"));
  assert.deepEqual(setupNodes("lite").map((n) => n.id), ["ipadapter-plus"]);
});

test("every downloadable catalogue model carries a SHA-256", () => {
  for (const m of MODEL_CATALOG) if (m.url) assert.match(m.sha256 ?? "", /^[0-9a-f]{64}$/, m.id);
});

test("local copies: same name and size in another install; Hugging Face cache by hash", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "strata-local-"));
  const prevHf = process.env.HF_HUB_CACHE;
  try {
    const bytes = Buffer.from("strata test weights ".repeat(1000));
    const sha = createHash("sha256").update(bytes).digest("hex");
    const model: CatalogModel = { id: "t", name: "T", role: "lora", dir: "loras", filename: "t.safetensors", url: "https://x/t", bytes: bytes.length, sha256: sha, profiles: ["lite"], required: true };
    const other = path.join(tmp, "OtherComfy", "models", "loras");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "t.safetensors"), bytes);
    // A same-named file of another size is never offered.
    fs.mkdirSync(path.join(tmp, "Wrong", "models"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "Wrong", "models", "t.safetensors"), "short");
    process.env.HF_HUB_CACHE = path.join(tmp, "no-cache");
    const found = findLocalCopy(model, [path.join(tmp, "Wrong"), path.join(tmp, "OtherComfy")], path.join(tmp, "Target", "models", "loras", "t.safetensors"));
    assert.equal(found?.path, path.join(other, "t.safetensors"));
    assert.equal(found?.trusted, false, "name matches are hashed before use");
    assert.equal(await sha256File(found!.path), sha);

    const blobs = path.join(tmp, "hub", "models--org--repo", "blobs");
    fs.mkdirSync(blobs, { recursive: true });
    fs.writeFileSync(path.join(blobs, sha), bytes);
    process.env.HF_HUB_CACHE = path.join(tmp, "hub");
    assert.deepEqual(findLocalCopy({ ...model, filename: "renamed.safetensors" }, [], ""), { path: path.join(blobs, sha), trusted: true });
  } finally {
    if (prevHf === undefined) delete process.env.HF_HUB_CACHE;
    else process.env.HF_HUB_CACHE = prevHf;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("install kinds: manual, portable and ComfyUI Desktop folders", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "strata-kind-"));
  try {
    const mk = (...p: string[]) => fs.mkdirSync(path.join(tmp, ...p), { recursive: true });
    const touch = (...p: string[]) => fs.writeFileSync(path.join(tmp, ...p), "");
    mk("manual", "models");
    touch("manual", "main.py");
    mk("portable", "ComfyUI", "models");
    touch("portable", "ComfyUI", "main.py");
    mk("portable", "python_embeded");
    mk("desktop", "models");
    mk("desktop", "custom_nodes");
    mk("desktop", ".venv", "Lib", "site-packages", "torch");
    fs.writeFileSync(path.join(tmp, "desktop", ".venv", "Lib", "site-packages", "torch", "version.py"), "cuda: Optional[str] = '12.8'\n");
    mk("notcomfy", "models");

    assert.equal(describeInstall(path.join(tmp, "manual")).kind, "manual");
    assert.equal(describeInstall(path.join(tmp, "portable", "ComfyUI")).kind, "portable");
    const desktop = describeInstall(path.join(tmp, "desktop"));
    assert.equal(desktop.kind, "desktop");
    assert.equal(desktop.gpuTorch, true);
    assert.equal(desktop.canStart, false, "the Desktop app runs its own server");
    assert.ok(isComfyDir(path.join(tmp, "desktop")));
    assert.ok(!isComfyDir(path.join(tmp, "notcomfy")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
