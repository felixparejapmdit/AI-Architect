# Strata

Structure-locked AI material rendering for architects and interior designers, running on a local ComfyUI. Drop in a room photo or render, drop reference photos onto **Floor / Walls / Ceiling / Furniture**, and Strata re-finishes only those surfaces. Walls, doors, windows and columns stay pixel-identical. It then exports a costed specification proposal (PDF) with Philippine, tropical-rated materials.

## What stays the same

- **Outside the masks:** every pixel is the original (the render is composited back over the base image).
- **Inside the masks:** only the finish changes. Geometry is held by the **depth lock** (Depth Anything 3 → depth ControlNet: each wall, floor and ceiling stays on its original plane) and the **line lock** (Canny; old surface texture is removed, but the corners *between* surfaces are kept). Reference images are applied with IP-Adapter in **style transfer** mode, which transfers colour and texture but not objects or layout. Material strength defaults to 75% so the original shading anchors the result.
- **Openings and fixtures:** put windows, doors, beams and lights in the **Protected** layer (or run **Auto-detect**, which finds them). Anything inside a surface mask and not protected can be repainted; Strata warns when walls or ceiling are masked with nothing protected.
- **Check it:** `npx tsx scripts/structure-check.mts <original> <render>` compares Depth Anything 3 depth maps (1.00 = identical geometry; a moved wall drops well below 0.95).

## Sample

| Base | Floor only (marble reference) | Floor, walls and ceiling |
|---|---|---|
| ![before](docs/samples/before.png) | ![floor](docs/samples/after-floor.png) | ![three surfaces](docs/samples/after-floor-walls-ceiling.png) |

Rendered on a CPU-only i5-7400 with 8 GB RAM (Lite profile, 768 px, 6 LCM steps). Window, mullions, radiator and sofa stay pixel-identical because they are outside the masks. Every wall, corner and the ceiling stay where they were: `scripts/structure-check.mts` scores the third image 0.998 against the base (left wall 0.999). The small wall sockets on the left were inside the walls mask and got the new finish; paint fixtures like these into **Protected** to keep them.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the pipeline and how it departs from the original blueprint.

## Requirements

- Node.js 20.9+ (developed on 24)
- ComfyUI **0.42 or newer** (native SAM3, Depth Anything 3 and Canny nodes): a manual install with its own venv, the Windows portable build, or ComfyUI Desktop. Setup adds the
  [ComfyUI_IPAdapter_plus](https://github.com/cubiq/ComfyUI_IPAdapter_plus) custom node (and [Ultimate SD Upscale](https://github.com/ssitu/ComfyUI_UltimateSDUpscale) on the Studio profile)
- Google Chrome or Microsoft Edge (used headless for PDF export); the Playwright tests need Google Chrome
- The project on an NTFS (or other junction/symlink-capable) drive: `npm run build` fails on exFAT with `failed to create junction point`, because Turbopack cannot create its links there

## Run

```bash
npm install
npm run build
npm start            # http://127.0.0.1:4787
```

Run these from the project folder.

Then open **Model manager → Set up everything**. Strata does the rest:

- **Finds ComfyUI**: the running server (on 8188, 8189, 8000, …, using ComfyUI's own folder list), ComfyUI Desktop's base path, or a `ComfyUI*` folder in your home, Documents, Desktop or the usual places on every drive (`X:\ComfyUI`, `X:\AI`, `X:\PROJECTS`, portable builds). It saves the folder and URL; if ComfyUI later answers on a different local port, Strata switches to it by itself.
- **Reads the hardware**: CPU-only or CUDA/ROCm PyTorch build, NVIDIA VRAM and RAM pick the profile (Lite / Studio) and the launch flags.
- **Installs missing node packs** (IPAdapter Plus; Ultimate SD Upscale on Studio) with Git, or as a zip through ComfyUI's own Python when Git is not installed.
- **Starts ComfyUI** in the background with the right flags (`--cpu` without a GPU, local only, no browser pop-up), or **restarts** it when it runs with a flag that breaks Strata (`--fp16-unet`, `--fp8_e4m3fn-unet` on CPU). It never restarts while a job is queued, and never stops a process that is not ComfyUI. Its log is `.strata/comfyui.log`.
- **Installs every model this machine needs**, fastest first: an identical copy already on the machine (Hugging Face cache, another ComfyUI, A1111/Forge/Fooocus/StabilityMatrix, Downloads) is hard-linked in seconds without using more disk space; only the rest is downloaded, two at a time, resuming dropped connections. Every file is checked against Hugging Face's SHA-256 before it is installed.
- **Makes the low-memory copies** (fp8-ready UNet, text encoder, fp16 CLIP Vision) on CPU / small-RAM hosts as soon as their source is in place.

**Start ComfyUI** in Settings and **Start** in the Render tab also appear whenever ComfyUI is offline, and **Auto-detect** in Settings fills in the folder and URL. Use `npm run dev` while developing; the service worker (offline shell, installable PWA) only registers in production builds.

Downloads are limited by your internet line, not by Strata: on a 13 Mbps (1.6 MB/s) connection the full Lite set (8.6 GB) takes about 90 minutes, and splitting files over several connections measured no faster. Reusing local copies is what makes setup fast.

## First run

1. **Model manager → Set up everything** (above). Strata recommends **Lite** (CPU / ≤8 GB VRAM) or **Studio** (SDXL, NVIDIA ≥12 GB) from your hardware; the list below the setup panel lets you install single models by hand.
2. Drop a base image on the canvas.
3. **Auto-detect** (SAM3) masks floor, walls, ceiling, furniture and protected structure. Refine with Brush `B`, Eraser `E` or Magic wand `W`; `1`–`4` and `0` switch layers.
4. Pick a **Style** (Modern minimal, Warm tropical, Japandi, Industrial, Luxe stone) for coordinated finishes, and/or drop reference photos into a surface. Strata classifies the texture and picks a tropical-rated catalogue material (overridable). Unevenly lit reference photos are evened out first, so the shadow does not transfer with the material.
5. **Generate** (`Ctrl+Enter`). A live preview streams while sampling; the result opens in a before/after slider.
6. Fill in room dimensions, budget and target handover in **Project**, check **Proposal → Before you send** (budget, deadline, unspecified surfaces, long-lead items), then **Export PDF**. The PDF includes an indicative installation programme.

## Keyboard

| Key | Action |
|---|---|
| `V` or `H` / `B` / `E` / `W` | Pan / brush / eraser / magic wand |
| `1` `2` `3` `4` `0` | Floor / walls / ceiling / furniture / protected |
| `[` `]` | Brush size |
| `Alt` + paint or click | Erase / subtract |
| `Space` + drag, scroll | Pan |
| `Ctrl` + scroll | Zoom |
| `F` / `C` / `M` | Fit / toggle compare / toggle masks |
| `Ctrl+Z` / `Ctrl+Enter` | Undo mask edit / generate |
| `Esc` | Close dialog |

## Performance (CPU / 8 GB machines)

Measured on an i5-7400 with 8 GB RAM (`scripts/profile-generate.mts` reproduces these per node):

| Lite render, floor only | Time |
|---|---|
| Full frame, CFG 1.5, 4K every render (old defaults) | 911 s |
| Crop to edited region, CFG 1.0, 4K on demand (new defaults) | 550 s |
| UI **Generate** with a reference image, fp8 UNet | 493 s cold (+~135 s once per new reference image) |
| UI **4K** button on a finished render | 95 s |
| UI **Generate**, floor + walls + ceiling, depth and line locks | 1713 s |
| UI **Generate**, floor + walls + ceiling, depth lock alone (low-memory default) | 818 s |

What Strata does automatically:
- **Crops** diffusion to the edited region plus context and pastes it back over the untouched original.
- **CFG 1.0** with LCM, so ComfyUI skips the negative pass (half the work per step).
- **4K on demand**: click **4K** on the render you keep; proposal export upscales automatically.
- **Encodes reference images in a separate small job** and caches the embeddings, so the CLIP Vision encoder is never in memory together with the diffusion models (the point where 8 GB machines crashed).
- **Unloads ComfyUI's model cache** on CPU when the next job needs different models (Auto-detect, reference encoding, render); keeping everything resident crashed with out-of-memory.
- **Runs one ControlNet (depth) on CPU / low-memory hosts.** Each fp32 ControlNet costs ~1.4 GB. Depth alone held the geometry just as well (structure check 0.998) and halved a three-surface render.

What you should do:
- Start ComfyUI with plain **`--cpu`**, no dtype flags. Each global flag breaks something on CPU: `--fp16-unet` breaks IP-Adapter ("mat1 and mat2 must have the same dtype"); `--fp8_e4m3fn-unet` breaks SAM3 Auto-detect ("slow_conv2d_cpu not implemented for Float8_e4m3fn"). Strata detects both and explains before running.
- In **Model manager**, click **Convert** on *Realistic Vision 5.1 UNet* and *text encoder*. Strata then loads only the render UNet with fp8 weight storage (a quarter of fp32, still computed in fp32), per model, so SAM3 and IP-Adapter keep full precision. Without this, the full fp32 checkpoint ran an 8 GB machine out of memory.
- Also **Convert** *CLIP ViT-H/14 (fp16, low-memory)*. The fp16 copy is identical to what ComfyUI already uses in memory, minus a ~3.8 GB loading spike.
- Iterate in the **Draft** quality preset (512 px, 4 steps); render the keeper in **Standard**. Back-to-back renders keep the models loaded, so only the first render after starting ComfyUI or after Auto-detect pays the model-loading cost.
- **Close heavy apps** (editors, extra browser tabs, a second ComfyUI) before rendering. With under ~1.5 GB of RAM free, Windows swaps model weights to disk on every step; the Render tab warns you.
- Keep **free space on C:** (or move the pagefile to another drive). A full C: stops the pagefile from growing, and ComfyUI then crashes with `os error 1455`.

## Tests

```bash
npm test          # graph builders vs. a captured ComfyUI 0.42 schema, BOQ, programme and checks, styles, material rules,
                  # texture classifier and equalizer, proposal HTML, setup detection, local-copy reuse and checksums
npm run build     # needed first: test:e2e serves the production build through `npm start`
npm run test:e2e  # Playwright, installed Chrome: the main pages and workflows, Generate/4K/PDF, one-click setup, start/restart,
                  # auto-detect, styles and proposal checks, with ComfyUI mocked (~1 min)
npm run typecheck

# Per-node timing of the real generation graph against a running ComfyUI:
npx tsx scripts/profile-generate.mts --project <id> --surfaces floor --crop
```

## Material data

`lib/materials.ts` holds the built-in catalogue (sintered stone, slim porcelain + mandatory epoxy grout, PU-cement screed, SPC with vapour barrier, anti-mould paint, MR gypsum, fibre-cement and more). Rates are **indicative** Metro Manila PHP figures and every entry is editable in the Material Library. Confirm suppliers and prices by quotation before issuing a proposal.
