export const IMAGE_TOOL_NAME = "generate_image";
export const IMAGE_RESULT_TYPE = "pi-image-result";
export const IMAGE_DIRECT_COMMAND = "generate_image_direct";
export const IMAGE_ABORT_COMMAND = "abort_image_generation";

export type ImageAspect = "square" | "portrait" | "landscape";

export const IMAGE_RUNTIME_PROVIDER = "xai";

export interface ImageCapabilities {
  editing?: boolean;
  sizes?: string[];
  resolutions?: string[];
  qualities?: string[];
}

export interface ImageConnectionView {
  id: string;
  label: string;
  provider: string;
  model: string;
  capabilities: ImageCapabilities;
  defaults?: { size?: string; resolution?: string; quality?: string };
}

export interface ImageConfigView {
  defaultConnection: string;
  connections: ImageConnectionView[];
}

const RATIO_ASPECT: Record<string, ImageAspect> = {
  "1:1": "square",
  "2:3": "portrait",
  "3:4": "portrait",
  "9:16": "portrait",
  "1:2": "portrait",
  "9:19.5": "portrait",
  "9:20": "portrait",
  "3:2": "landscape",
  "4:3": "landscape",
  "16:9": "landscape",
  "2:1": "landscape",
  "21:9": "landscape",
  "5:2": "landscape",
  "19.5:9": "landscape",
  "20:9": "landscape",
};

export function parseImageSize(size: string): { width: number; height: number } | null {
  const match = /^(\d+)x(\d+)$/.exec(size.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

export function imageAspectOfSize(size: string): ImageAspect | null {
  const value = size.trim();
  if (RATIO_ASPECT[value]) return RATIO_ASPECT[value];
  const parsed = parseImageSize(value);
  if (!parsed) return null;
  if (parsed.width === parsed.height) return "square";
  return parsed.width > parsed.height ? "landscape" : "portrait";
}

export function imageRatioKind(size: string): ImageAspect | "auto" | null {
  const value = size.trim();
  if (value === "auto") return "auto";
  return imageAspectOfSize(value);
}

export function xaiAspectRatio(size?: string): string | undefined {
  if (!size) return undefined;
  const value = size.trim();
  if (!value) return undefined;
  if (value === "auto" || RATIO_ASPECT[value] || /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(value)) return value;
  const aspect = imageAspectOfSize(value);
  if (aspect === "square") return "1:1";
  if (aspect === "portrait") return "2:3";
  if (aspect === "landscape") return "16:9";
  throw new Error(`Unsupported image size: ${size}`);
}

export function imageAspectOptions(sizes: string[] | undefined): Array<{ aspect: ImageAspect; size: string }> {
  if (!sizes?.length) return [];
  const seen = new Set<ImageAspect>();
  const options: Array<{ aspect: ImageAspect; size: string }> = [];
  for (const size of sizes) {
    const aspect = imageAspectOfSize(size);
    if (!aspect || seen.has(aspect)) continue;
    seen.add(aspect);
    options.push({ aspect, size });
  }
  return options;
}

export function sizeForImageAspect(sizes: string[] | undefined, aspect: ImageAspect): string | undefined {
  return imageAspectOptions(sizes).find((option) => option.aspect === aspect)?.size;
}

export interface EncodedImageInput {
  data: string;
  mimeType: string;
  fileName?: string;
}

const MENTIONED_IMAGE = /@"([^"]+)"|@([^\s"]+)/g;
const IMAGE_FILE = /\.(?:png|jpe?g|webp)$/i;

function mentionedImagePathFromMatch(match: RegExpMatchArray): string | undefined {
  const raw = (match[1] ?? match[2] ?? "").replace(/[),.;]+$/, "");
  if (!IMAGE_FILE.test(raw) || raw.split(/[\\/]/).includes("..")) return undefined;
  return raw;
}

export function extractMentionedImagePath(text: string): string | undefined {
  let found: string | undefined;
  for (const match of text.matchAll(MENTIONED_IMAGE)) {
    const path = mentionedImagePathFromMatch(match);
    if (path) found = path;
  }
  return found;
}

export function splitImageMentions(text: string): Array<{ type: "text"; value: string } | { type: "mention"; path: string }> {
  const parts: Array<{ type: "text"; value: string } | { type: "mention"; path: string }> = [];
  let last = 0;
  for (const match of text.matchAll(MENTIONED_IMAGE)) {
    const path = mentionedImagePathFromMatch(match);
    const index = match.index ?? 0;
    if (!path) continue;
    if (index > last) parts.push({ type: "text", value: text.slice(last, index) });
    parts.push({ type: "mention", path });
    last = index + match[0].length;
  }
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  return parts.length ? parts : [{ type: "text", value: text }];
}

export interface ImageGenerationRequest {
  prompt: string;
  connection?: string;
  target?: string;
  references?: string[];
  use_last_attachment?: boolean;
  new_image?: boolean;
  target_image?: EncodedImageInput;
  reference_images?: EncodedImageInput[];
  size?: string;
  resolution?: string;
  quality?: string;
}

export interface ImageGenerationResult {
  type: typeof IMAGE_RESULT_TYPE;
  version: 1;
  path: string;
  mimeType: string;
  width: number;
  height: number;
  prompt: string;
  connection: string;
  model: string;
  size?: string;
  resolution?: string;
  quality?: string;
  source?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getImageGenerationResult(value: unknown): ImageGenerationResult | null {
  if (!isRecord(value) || ![IMAGE_RESULT_TYPE, "pi-web:image"].includes(value.type as string) || value.version !== 1) return null;
  const isCurrent = value.type === IMAGE_RESULT_TYPE;
  if (
    typeof value.path !== "string" || !value.path
    || (isCurrent && (!value.path.startsWith(".pi/generated-images/") || value.path.split(/[\\/]/).includes("..")))
    || typeof value.mimeType !== "string" || !value.mimeType.startsWith("image/")
    || typeof value.prompt !== "string" || !value.prompt
    || typeof value.connection !== "string" || !value.connection
    || typeof value.model !== "string" || !value.model
    || typeof value.width !== "number" || !Number.isSafeInteger(value.width) || value.width <= 0
    || typeof value.height !== "number" || !Number.isSafeInteger(value.height) || value.height <= 0
    || (value.size !== undefined && typeof value.size !== "string")
    || (value.resolution !== undefined && typeof value.resolution !== "string")
    || (value.quality !== undefined && typeof value.quality !== "string")
    || (value.source !== undefined && typeof value.source !== "string")
  ) return null;
  return { ...value, type: IMAGE_RESULT_TYPE } as unknown as ImageGenerationResult;
}

export function imageToolDisplayKind(toolName: string, args?: unknown, resultDetails?: unknown): "edit" | "generate" | null {
  if (toolName !== IMAGE_TOOL_NAME) return null;
  const result = getImageGenerationResult(resultDetails);
  if (result) return result.source ? "edit" : "generate";
  if (isRecord(args) && args.new_image === true) return "generate";
  if (isRecord(args) && ((typeof args.target === "string" && args.target) || args.use_last_attachment === true)) return "edit";
  return null;
}