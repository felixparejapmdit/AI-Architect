# Strata: architecture and blueprint review

This document records how Strata implements the original four-phase blueprint and where it deliberately departs from it.

## Blueprint review: what changed and why

| Blueprint said | Problem | What Strata does |
|---|---|---|
| SAM "automatically generates masks for ceiling, floor, walls" | Classic SAM is class-agnostic: it outputs segments with no labels. | ComfyUI 0.42 ships **SAM3** natively, which is text-prompted. One `SAM3_Detect` per layer with multi-concept prompts (`wall:8`, `sofa:4, chair:8, …`). The user can refine with brush, eraser, and magic wand. |
| "fed into two ControlNets simultaneously:" | The list was cut off. No official MLSD ControlNet exists for SDXL. | Lite: Canny (lines) + optional depth (SD1.5). Studio: **ControlNet Union ProMax**, one model with type `canny/lineart/anime_lineart/mlsd` for lines and `depth` for depth. |
| ControlNet alone gives "structural lock-in" | ControlNet guides; it does not guarantee. It also locks the old floor's grout lines into the new material. | (1) Sampling is confined to the union mask (`SetLatentNoiseMask`). (2) The render is composited over the untouched original (`ImageCompositeMasked`), so every pixel outside the masks is the original. (3) The Canny map is blanked inside the eroded editable area, so old texture is not forced back. (4) A **Protected** layer (windows, doors, columns, beams) is subtracted from every surface. |
| SDXL **or Flux.1** | IP-Adapter Plus SDXL and ControlNet Union are SDXL-only; Flux needs a different stack. | SDXL only (RealVisXL V5 recommended over base SDXL for interiors). |
| Ultimate SD Upscale → 4K | USDU is a tiled diffusion pass: it can change structure and is far too slow on CPU. | Studio: USDU at 0.25 denoise, then **re-locked at 4K** against an ESRGAN-upscaled original. Lite: pure ESRGAN (4x-UltraSharp) to 3840 px. |
| Browser POSTs to `127.0.0.1:8188/prompt` | Needs `--enable-cors-header`; ComfyUI's origin check returns 403 when the page host differs (`localhost` vs `127.0.0.1`). | A same-origin Next.js proxy (`/api/comfy/*`, allow-listed endpoints) plus a WebSocket→SSE bridge (`/api/events`) that also forwards live latent previews. ComfyUI runs unmodified. |
| PWA "sends a script command to execute wget" | A browser cannot run commands, and an open local command endpoint is a security hole. | The local Next server downloads only **catalogue entries** (hard-coded, verified URLs) into `ComfyUI/models/<dir>`, two at a time with resume-on-drop retries. Custom-node install is limited to listed repos. |
| "AI detects a large-format stone texture" | No such detector exists in the pipeline. | A transparent heuristic classifier (colour, contrast, gradient energy, grain coherence, grout periodicity) proposes a family; tropical rules pick the catalogue item; the user can pin an override. |
| BOQ "estimated area calculations" | Areas cannot be measured from a single perspective photo without scale. | Quantities come from entered room dimensions (area, height, perimeter, openings). Mask coverage is shown but never used as m². |
| Specific supplier addresses and PHP costs | These change and could not be verified. | Suppliers are given at company and district level as in the brief. Rates are labelled indicative and editable in the Material Library. The PDF states that quotations must confirm them. |
| SDXL + 2 ControlNets + IP-Adapter + USDU as the only path | Needs ≥12 GB VRAM. The development machine is an i5-7400 with no NVIDIA GPU and 8 GB RAM. | Two profiles. **Lite** (SD1.5 + LCM, 6 steps) runs on CPU; **Studio** is the blueprint's SDXL stack. The doctor endpoint recommends one from the hardware. |

## Reference projects reviewed (October 2026)

Five open-source projects were studied for ideas. Strata takes the technique, never the code, and only what fits its rule that nothing outside the specified surfaces changes and that it runs on an 8 GB CPU machine.

| Project | What it does | Adopted | Not adopted, and why |
|---|---|---|---|
| [s-du/ScribbleArchitect](https://github.com/s-du/ScribbleArchitect) (no licence) | Scribbles → architecture with SD1.5 + LCM + ControlNet + IP-Adapter; a library of style reference images; ControlNet-tile upscale | Confirms Strata's Lite stack (it is the same recipe). Its style library became **Styles** (below). | Real-time scribble drawing and ADE20K segmentation brushes: Strata starts from a photo and has SAM3 layers. ControlNet-tile 4K: tiled diffusion takes hours on CPU and can drift structure; Studio already has Ultimate SD Upscale, Lite uses ESRGAN. |
| [harrydawitch/ArchIntelligent](https://github.com/harrydawitch/ArchIntelligent) (MIT) | SDXL + Canny ControlNet + style / building-function LoRAs; prompt modifiers for season, weather, time of day | **Styles**: one click puts coordinated finishes on floor, walls and ceiling. They map to catalogue materials, so they are costed, scheduled and zone-checked (wet zones swap in wet-rated equivalents) like any manual choice. | Weather, season and time-of-day modifiers: they change the whole picture, and Strata must change only the surfaces. SDXL style LoRAs: Studio-only and from a private model list. |
| [AUTOMATIC1111 inpainting](https://github.com/AUTOMATIC1111/stable-diffusion-webui) | Inpainting checkpoints (or merging an architectural model with SD-1.5-inpainting) for local edits | Next experiment, not yet default: Realistic Vision publishes an official inpainting build of the checkpoint Strata already uses (`Realistic_Vision_V5.1_fp16-no-ema-inpainting.safetensors`, 2.13 GB). With `InpaintModelConditioning` it would let material strength go to 100% without the old finish bleeding through. | Changes the core graph; it needs an A/B render on the reference room with `scripts/structure-check.mts` (geometry must stay ≥ 0.99) before it can replace the verified pipeline. |
| [amtarr/ComfyUI-TextureAlchemy](https://github.com/amtarr/ComfyUI-TextureAlchemy) (Apache-2.0) | PBR toolkit; Texture Equalizer (high-pass lighting removal), seamless tiling | **Even out reference lighting**: the equalizer's technique, rewritten in the browser (`equalizeLighting` in `lib/texture.ts`). It is adaptive: an evenly lit photo is left untouched (marble veining is not flattened), a photo with a shadow or vignette is corrected before IP-Adapter encodes it. | PBR extraction, seamless tiling, wear generation: for 3D texturing, not photo re-finishing; CLIP Vision centre-crops references anyway. |
| [awaisqarnise/proposal-generator-agent](https://github.com/awaisqarnise/proposal-generator-agent) (no formal licence; a LangGraph learning project) | Extract requirements → cost and timeline → "unrealistic expectations" check → proposal | The pipeline shape, without an LLM: **indicative programme** (crew output, lead and cure times per material; trades top-down, each waiting for its material) in the Project tab and the PDF, and **Before you send** checks (budget overrun with the cheapest zone-safe swaps, late handover with the long-lead item, masked-but-unspecified surfaces, missing client). | An LLM agent: it needs an API key or a local model that cannot share 8 GB with ComfyUI, and BOQ figures must be deterministic. |
| [microsoft/hve-core](https://github.com/microsoft/hve-core) (MIT) | GitHub Copilot instructions, agents and design-thinking coaching | The "value for each stakeholder" idea is why the proposal now carries schedule and budget, not only cost and look. | It is a development-process toolkit, with nothing to run inside Strata. |

## Setup and auto-configuration

`lib/server/setup.ts` replaces "start ComfyUI yourself and download models by hand":

- **Detection** probes the configured URL and local ports 8188, 8189, 8000, 8190 and 8288 (`/system_stats`), reads the real model folders from ComfyUI's `/internal/folder_paths`, and otherwise scans ComfyUI Desktop's config, home folders and the usual places on each drive. `torch/version.py` tells a CPU-only build from a CUDA / ROCm one without importing torch, and `nvidia-smi` gives the VRAM.
- **One-click setup** runs these steps in order: save config → node packs (Git, or a zip via ComfyUI's Python) → start / restart ComfyUI (refuses while jobs are queued, verifies the PID's command line is ComfyUI) → models → conversions. A start failure (e.g. ComfyUI Desktop, which runs its own server) is reported and setup carries on with the models.
- **Models** come from an identical local copy when there is one (Hugging Face cache blobs match by SHA-256 name; same-name, same-size files elsewhere are hashed first) via a hard link, otherwise from Hugging Face. Every download is checked against the catalogue SHA-256 before it is renamed into place. Measured on the development machine's 13 Mbps line, parallel range requests were no faster than one connection, so files are not split.

## Data flow

```
Browser (PWA, IndexedDB)                     Next.js server (127.0.0.1:4787)            ComfyUI (:8188)
─────────────────────────                    ────────────────────────────────            ───────────────
project / masks / refs / renders  ──upload──▶ /api/comfy/upload/image  ──────────────▶   input/strata/*
graph JSON (lib/workflow/*)       ──queue───▶ /api/comfy/prompt        ──────────────▶   /prompt
progress, previews                ◀──SSE──── /api/events  ◀── WebSocket ──────────────   /ws
outputs                           ◀──────── /api/comfy/view, /history ◀──────────────   output/strata/*
proposal payload                  ──POST───▶ /api/proposal → puppeteer-core + system Chrome/Edge → PDF
model download                    ──POST───▶ /api/models → local copy (hard link) or download, SHA-256 checked
one-click setup                   ──POST───▶ /api/setup → detect, node packs, start ComfyUI, models, conversions
```

## Generation graph (Lite)

```
Checkpoint ─ LCM LoRA ─┬─ IPAdapterAdvanced(floor ref, attn_mask=floor) ─ … per surface ─┐
                       │                                                                  ▼
Global prompt ─ + ConditioningSetMask(per-surface prompt, surface mask) ─ ControlNet(lines[, depth]) ─ KSampler
Base ─ Canny ─ blank inside eroded union mask ───────────────────────────┘                  ▲
Base ─ VAEEncode ─ SetLatentNoiseMask(union hard) ───────────────────────────────────────────┘
KSampler ─ VAEDecode ─ ImageCompositeMasked(dest = base, mask = union soft) ─ Save preview
                                         └─ ImageUpscaleWithModel(UltraSharp) ─ ImageScale(3840) ─ Save final
```

`applyDefaults()` fills any required inputs a node pack adds later from the live `/object_info`, and `validatePrompt()` turns schema mismatches into readable messages before anything is queued.

## Storage

Everything user-created lives in the browser's IndexedDB (`strata` database): projects, mask PNGs (alpha), references, renders, custom materials. Server-side state is only `.strata/config.json` (ComfyUI URL and folder) and `.strata/comfyui.log` when Strata started ComfyUI.
