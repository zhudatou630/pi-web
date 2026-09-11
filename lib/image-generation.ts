export const IMAGE_TOOL_NAME = "generate_image";
export const IMAGE_RESULT_TYPE = "pi-image-result";
export const IMAGE_DIRECT_COMMAND = "generate_image_direct";
export const IMAGE_ABORT_COMMAND = "abort_image_generation";

type ImageAspect = "square" | "portrait" | "landscape";

export type ImageConnectionTransport = "codex" | "antigravity" | "xai" | "openai-images";

export const IMAGE_CUSTOM_MODEL_PRESETS = [
  { model: "gpt-image-2.5-flare", label: "Flare" },
  { model: "gpt-image-2.5-sunburst", label: "Sunburst" },
  { model: "grok-imagine-image-2.0", label: "Grok" },
] as const;

export function imageConnectionTransport(connection: { provider: string; model: string }): ImageConnectionTransport {
  if (connection.provider === "openai-codex") return "codex";
  if (connection.provider === "antigravity") return "antigravity";
  if (connection.model.startsWith("grok-imagine")) return "xai";
  return "openai-images";
}

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

function parseImageDimensions(size: string): { width: number; height: number } | null {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(size.trim()) ?? /^(\d+)x(\d+)$/.exec(size.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function imageAspectOfSize(size: string): ImageAspect | null {
  const parsed = parseImageDimensions(size);
  if (!parsed) return null;
  if (parsed.width === parsed.height) return "square";
  return parsed.width > parsed.height ? "landscape" : "portrait";
}

const DISPLAY_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
const DISPLAY_RATIO_TOLERANCE = 0.03;

export function imagePixelRatio(width: number, height: number): string {
  let a = Math.abs(width);
  let b = Math.abs(height);
  while (b) {
    const next = a % b;
    a = b;
    b = next;
  }
  return `${width / a}:${height / a}`;
}

export function imageDisplayRatio(width: number, height: number): string {
  if (width <= 0 || height <= 0) return imagePixelRatio(width, height);
  const actual = width / height;
  let best: (typeof DISPLAY_RATIOS)[number] = DISPLAY_RATIOS[0];
  let bestError = Infinity;
  for (const ratio of DISPLAY_RATIOS) {
    const [a, b] = ratio.split(":").map(Number);
    const error = Math.abs(actual - a / b) / (a / b);
    if (error < bestError) {
      best = ratio;
      bestError = error;
    }
  }
  return bestError <= DISPLAY_RATIO_TOLERANCE ? best : imagePixelRatio(width, height);
}

export function imageRatioKind(size: string): ImageAspect | "auto" | null {
  const value = size.trim();
  if (value === "auto") return "auto";
  return imageAspectOfSize(value);
}

const OPENAI_IMAGE_SIZES: Record<string, string> = {
  auto: "auto",
  "1:1": "1024x1024",
  "16:9": "1536x864",
  "9:16": "864x1536",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
  "4:3": "1024x768",
  "3:4": "768x1024",
};

export function openaiImageSize(size?: string): string | undefined {
  if (!size) return undefined;
  const value = size.trim();
  if (!value) return undefined;
  const mapped = OPENAI_IMAGE_SIZES[value];
  if (mapped) return mapped;
  throw new Error(`Unsupported image size: ${size}`);
}

export function xaiAspectRatio(size?: string): string | undefined {
  if (!size) return undefined;
  const value = size.trim();
  if (!value) return undefined;
  if (value === "auto") return value;
  const aspect = imageAspectOfSize(value);
  if (value.includes(":") && aspect) return value;
  if (aspect === "square") return "1:1";
  if (aspect === "portrait") return "2:3";
  if (aspect === "landscape") return "16:9";
  throw new Error(`Unsupported image size: ${size}`);
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
  use_last_attachment?: boolean;
  new_image?: boolean;
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
  label?: string;
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
    || (value.label !== undefined && (typeof value.label !== "string" || !value.label))
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