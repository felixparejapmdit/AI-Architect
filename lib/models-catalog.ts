import type { PipelineProfile } from "./types";

export type ModelRole = "checkpoint" | "unet" | "text_encoder" | "vae" | "lora" | "controlnet" | "ipadapter" | "clip_vision" | "depth" | "segmentation" | "upscale";

export interface CatalogModel {
  id: string;
  name: string;
  role: ModelRole;
  /** Folder under ComfyUI/models. */
  dir: string;
  filename: string;
  url: string;
  bytes: number;
  /** Hugging Face's LFS SHA-256 (its X-Linked-ETag); downloads and local copies are checked against it. */
  sha256?: string;
  profiles: PipelineProfile[];
  /** Part of the minimum set the profile needs to render. */
  required: boolean;
  /**
   * Optional models one-click setup still installs: "always" for features the app leans on
   * (Auto-detect, 4K), "low-memory" for the conversions that keep CPU / small-RAM hosts alive.
   */
  setup?: "always" | "low-memory";
  note?: string;
  /** Produced locally from another catalogue model instead of downloaded (url is unused). */
  convertFrom?: string;
  /** How a derived model is produced from `convertFrom`. */
  convert?: "fp16" | "extract-unet" | "extract-clip";
}

/**
 * Every URL here was verified against Hugging Face. Downloads are restricted to this list
 * server-side so the local API can never be used to fetch arbitrary files.
 */
export const MODEL_CATALOG: CatalogModel[] = [
  // Shared
  {
    id: "sam3",
    name: "SAM 3.1 (text-prompted segmentation)",
    role: "segmentation",
    dir: "checkpoints",
    filename: "sam3.1_multiplex_fp16.safetensors",
    url: "https://huggingface.co/Comfy-Org/sam3.1/resolve/main/checkpoints/sam3.1_multiplex_fp16.safetensors",
    bytes: 1745546848,
    sha256: "9ba99c92703c2e8b4f47de2d34a539bb8e18923049e238b780d70dbe6368eb03",
    profiles: ["lite", "studio"],
    required: false,
    setup: "always",
    note: "Auto-detects floor, walls, ceiling, furniture and protected structure. Without it, paint masks by hand.",
  },
  {
    id: "clip-vision-h",
    name: "CLIP ViT-H/14 image encoder",
    role: "clip_vision",
    dir: "clip_vision",
    filename: "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors",
    url: "https://huggingface.co/h94/IP-Adapter/resolve/main/models/image_encoder/model.safetensors",
    bytes: 2528373448,
    sha256: "6ca9667da1ca9e0b0f75e46bb030f7e011f44f86cbfb8d5a36590fcd7507b030",
    profiles: ["lite", "studio"],
    required: true,
    note: "Encodes your reference images for IP-Adapter.",
  },
  {
    id: "clip-vision-h-fp16",
    name: "CLIP ViT-H/14 image encoder (fp16, low-memory)",
    role: "clip_vision",
    dir: "clip_vision",
    filename: "CLIP-ViT-H-14-laion2B-s32B-b79K.fp16.safetensors",
    url: "",
    bytes: 0,
    profiles: ["lite", "studio"],
    required: false,
    setup: "low-memory",
    convertFrom: "clip-vision-h",
    convert: "fp16",
    note: "Half-size copy of the encoder above, made locally. ComfyUI already runs it in fp16 on CPU, so results are identical, but loading no longer needs ~3.8 GB at once. Recommended on 8 GB machines.",
  },
  {
    id: "ultrasharp",
    name: "4x-UltraSharp ESRGAN",
    role: "upscale",
    dir: "upscale_models",
    filename: "4x-UltraSharp.pth",
    url: "https://huggingface.co/Kim2091/UltraSharp/resolve/main/4x-UltraSharp.pth",
    bytes: 66961958,
    sha256: "a5812231fc936b42af08a5edba784195495d303d5b3248c24489ef0c4021fe01",
    profiles: ["lite", "studio"],
    required: false,
    setup: "always",
    note: "Sharper material micro-detail than RealESRGAN for the 4K pass.",
  },
  // Lite (CPU / ≤8 GB VRAM)
  {
    id: "rv51",
    name: "Realistic Vision 5.1 (SD1.5)",
    role: "checkpoint",
    dir: "checkpoints",
    filename: "Realistic_Vision_V5.1_fp16-no-ema.safetensors",
    url: "https://huggingface.co/SG161222/Realistic_Vision_V5.1_noVAE/resolve/main/Realistic_Vision_V5.1_fp16-no-ema.safetensors",
    bytes: 2132625894,
    sha256: "99a75a901f4fec732056930a89fa34cf360f6f72d75ce5bf333ddf82adf8dd2a",
    profiles: ["lite"],
    required: true,
  },
  {
    id: "rv51-unet",
    name: "Realistic Vision 5.1 UNet (low-memory renders)",
    role: "unet",
    dir: "diffusion_models",
    filename: "Realistic_Vision_V5.1_unet.safetensors",
    url: "",
    bytes: 0,
    profiles: ["lite"],
    required: false,
    setup: "low-memory",
    convertFrom: "rv51",
    convert: "extract-unet",
    note: "The checkpoint's diffusion model on its own, so Strata can store it in fp8 (a quarter of fp32) for renders without a global ComfyUI flag that would break Auto-detect. Recommended on 8 GB machines; convert this and the text encoder below.",
  },
  {
    id: "rv51-clip",
    name: "Realistic Vision 5.1 text encoder (low-memory renders)",
    role: "text_encoder",
    dir: "text_encoders",
    filename: "Realistic_Vision_V5.1_clip_l.safetensors",
    url: "",
    bytes: 0,
    profiles: ["lite"],
    required: false,
    setup: "low-memory",
    convertFrom: "rv51",
    convert: "extract-clip",
    note: "The checkpoint's CLIP-L text encoder on its own, used together with the UNet above.",
  },
  {
    id: "vae-ft-mse",
    name: "SD VAE ft-MSE (Realistic Vision's recommended VAE)",
    role: "vae",
    dir: "vae",
    filename: "vae-ft-mse-840000-ema-pruned.safetensors",
    url: "https://huggingface.co/stabilityai/sd-vae-ft-mse-original/resolve/main/vae-ft-mse-840000-ema-pruned.safetensors",
    bytes: 334641190,
    sha256: "735e4c3a447a3255760d7f86845f09f937809baa529c17370d83e4c3758f3c75",
    profiles: ["lite"],
    required: true,
    note: "The VAE the Realistic Vision authors pair with this no-VAE checkpoint. Low-memory renders load it next to the fp8 UNet; without it Strata falls back to the full fp32 checkpoint.",
  },
  {
    id: "lcm-sd15",
    name: "LCM LoRA (SD1.5), 6-step sampling",
    role: "lora",
    dir: "loras",
    filename: "lcm-lora-sdv1-5.safetensors",
    url: "https://huggingface.co/latent-consistency/lcm-lora-sdv1-5/resolve/main/pytorch_lora_weights.safetensors",
    bytes: 134621556,
    sha256: "8f90d840e075ff588a58e22c6586e2ae9a6f7922996ee6649a7f01072333afe4",
    profiles: ["lite"],
    // Lite's defaults (6 steps, CFG 1, lcm sampler) assume it.
    required: true,
    note: "Cuts sampling from ~25 to 6 steps; essential on CPU.",
  },
  {
    id: "cn-canny-sd15",
    name: "ControlNet Canny (SD1.5): line lock",
    role: "controlnet",
    dir: "controlnet",
    filename: "control_v11p_sd15_canny_fp16.safetensors",
    url: "https://huggingface.co/comfyanonymous/ControlNet-v1-1_fp16_safetensors/resolve/main/control_v11p_sd15_canny_fp16.safetensors",
    bytes: 722601100,
    sha256: "8932b66e15aae835b3490dbf989f56c253104cee08a88bf21283762f557c9f10",
    profiles: ["lite"],
    required: true,
  },
  {
    id: "cn-depth-sd15",
    name: "ControlNet Depth (SD1.5): perspective lock",
    note: "Keeps repainted walls, floor and ceiling on their original planes. Soft-lit rooms have few edges at the corners, so this is what holds the geometry.",
    role: "controlnet",
    dir: "controlnet",
    filename: "control_v11f1p_sd15_depth_fp16.safetensors",
    url: "https://huggingface.co/comfyanonymous/ControlNet-v1-1_fp16_safetensors/resolve/main/control_v11f1p_sd15_depth_fp16.safetensors",
    bytes: 722601100,
    sha256: "1c4a79aa52fb63f607cb9ff479ea5aa1923b6ceb21267bd14b69bd05d7b617be",
    profiles: ["lite"],
    required: true,
  },
  {
    id: "ipa-plus-sd15",
    name: "IP-Adapter Plus (SD1.5)",
    role: "ipadapter",
    dir: "ipadapter",
    filename: "ip-adapter-plus_sd15.safetensors",
    url: "https://huggingface.co/h94/IP-Adapter/resolve/main/models/ip-adapter-plus_sd15.safetensors",
    bytes: 98183288,
    sha256: "a1c250be40455cc61a43da1201ec3f1edaea71214865fb47f57927e06cbe4996",
    profiles: ["lite"],
    required: true,
    note: "Finer texture transfer than the base SD1.5 IP-Adapter.",
  },
  {
    id: "da3-small",
    name: "Depth Anything 3 Small",
    role: "depth",
    dir: "geometry_estimation",
    filename: "depth_anything_3_small.safetensors",
    url: "https://huggingface.co/Comfy-Org/Depth-Anything-3/resolve/main/geometry_estimation/depth_anything_3_small.safetensors",
    bytes: 137254980,
    sha256: "9c0a53d157c5b315d4c82908a43d93eeaa3a9ac3de9d15c2b4242ef46b5508ad",
    profiles: ["lite"],
    required: true,
  },
  // Studio (NVIDIA ≥12 GB VRAM): the blueprint's SDXL stack
  {
    id: "realvisxl5",
    name: "RealVisXL V5.0 (SDXL, photoreal)",
    role: "checkpoint",
    dir: "checkpoints",
    filename: "RealVisXL_V5.0_fp16.safetensors",
    url: "https://huggingface.co/SG161222/RealVisXL_V5.0/resolve/main/RealVisXL_V5.0_fp16.safetensors",
    bytes: 6938065488,
    sha256: "6a35a7855770ae9820a3c931d4964c3817b6d9e3c6f9c4dabb5b3a94e5643b80",
    profiles: ["studio"],
    required: false,
    setup: "always",
    note: "Recommended over SDXL base for interiors: far better materials and light.",
  },
  {
    id: "sdxl-base",
    name: "SDXL 1.0 Base",
    role: "checkpoint",
    dir: "checkpoints",
    filename: "sd_xl_base_1.0.safetensors",
    url: "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors",
    bytes: 6938078334,
    sha256: "31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b",
    profiles: ["studio"],
    required: false,
  },
  {
    id: "cn-union-sdxl",
    name: "ControlNet Union ProMax (SDXL): MLSD/lines + depth",
    role: "controlnet",
    dir: "controlnet",
    filename: "controlnet-union-sdxl-promax.safetensors",
    url: "https://huggingface.co/xinsir/controlnet-union-sdxl-1.0/resolve/main/diffusion_pytorch_model_promax.safetensors",
    bytes: 2513342408,
    sha256: "9fae2e50cb431bfcbe05822b59ec2228df545ef27f711dea8949e9f4ed9f7cdc",
    profiles: ["studio"],
    required: true,
    note: "One model drives both the line (MLSD/canny) and depth locks.",
  },
  {
    id: "ipa-plus-sdxl",
    name: "IP-Adapter Plus (SDXL, ViT-H)",
    role: "ipadapter",
    dir: "ipadapter",
    filename: "ip-adapter-plus_sdxl_vit-h.safetensors",
    url: "https://huggingface.co/h94/IP-Adapter/resolve/main/sdxl_models/ip-adapter-plus_sdxl_vit-h.safetensors",
    bytes: 847517512,
    sha256: "3f5062b8400c94b7159665b21ba5c62acdcd7682262743d7f2aefedef00e6581",
    profiles: ["studio"],
    required: true,
  },
  {
    id: "da3-large",
    name: "Depth Anything 3 Mono Large",
    role: "depth",
    dir: "geometry_estimation",
    filename: "depth_anything_3_mono_large.safetensors",
    url: "https://huggingface.co/Comfy-Org/Depth-Anything-3/resolve/main/geometry_estimation/depth_anything_3_mono_large.safetensors",
    bytes: 1336748056,
    sha256: "9b44eda5bedba5b4e125686fdb79d1db309c1b9785277576eb930f885b008f96",
    profiles: ["studio"],
    required: true,
  },
];

export interface CustomNodePack {
  id: string;
  name: string;
  repo: string;
  /** A node class that proves the pack is loaded. */
  probeClass: string;
  profiles: PipelineProfile[];
  required: boolean;
  /** Optional pack one-click setup still installs. */
  setup?: "always";
  /** Needs `git clone --recursive`; a plain zip of the repository would be incomplete. */
  submodules?: boolean;
  note: string;
}

export const CUSTOM_NODES: CustomNodePack[] = [
  {
    id: "ipadapter-plus",
    name: "ComfyUI IPAdapter Plus",
    repo: "https://github.com/cubiq/ComfyUI_IPAdapter_plus",
    probeClass: "IPAdapterAdvanced",
    profiles: ["lite", "studio"],
    required: true,
    note: "Regional, mask-scoped material transfer from reference images.",
  },
  {
    id: "ultimate-sd-upscale",
    name: "Ultimate SD Upscale",
    repo: "https://github.com/ssitu/ComfyUI_UltimateSDUpscale",
    probeClass: "UltimateSDUpscale",
    profiles: ["studio"],
    required: false,
    setup: "always",
    submodules: true,
    note: "Tiled diffusion upscale to 4K. Without it, Strata uses a pure ESRGAN 4K pass.",
  },
];

/**
 * What one-click setup installs for a profile: everything the profile renders with, the
 * features the app leans on, and, on CPU / small-RAM hosts, the low-memory conversions.
 */
export function setupModels(profile: PipelineProfile, lowMemory: boolean): CatalogModel[] {
  return MODEL_CATALOG.filter((m) => m.profiles.includes(profile) && (m.required || m.setup === "always" || (m.setup === "low-memory" && lowMemory)));
}

export function setupNodes(profile: PipelineProfile): CustomNodePack[] {
  return CUSTOM_NODES.filter((n) => n.profiles.includes(profile) && (n.required || n.setup === "always"));
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(0) + " MB";
  return (n / 1e3).toFixed(0) + " KB";
}
