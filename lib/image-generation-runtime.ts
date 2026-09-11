import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Buffer } from "node:buffer";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { getBase64DecodedByteLength } from "./image-attachments";
import { requestAntigravityImage } from "./image-generation-antigravity";
import { requestCodexImage } from "./image-generation-codex";
import { requestOpenAIImagesImage } from "./image-generation-openai-images";
import { requestXaiImage } from "./image-generation-xai";
import { IMAGE_RESULT_TYPE, extractMentionedImagePath, getImageGenerationResult, imageConnectionTransport, type ImageGenerationRequest, type ImageGenerationResult } from "./image-generation";
import { imageConfigView, resolveImageConfig } from "./image-generation-config";
import { isPathWithinRoots } from "./path-security";
import { toNativePath } from "./paths";

const MAX_PROMPT_LENGTH = 32_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

interface RuntimeContext {
  cwd: string;
  sessionManager: { getBranch(): readonly unknown[] };
  modelRegistry: {
    getProviderAuth(provider: string): Promise<{ auth: { baseUrl?: string; apiKey?: string; headers?: Record<string, unknown> } } | undefined>;
    getProvider(provider: string): { baseUrl?: string } | undefined;
  };
}

interface ImageFile {
  bytes: Buffer;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  extension: "png" | "jpg" | "webp";
  width: number;
  height: number;
}

interface EncodedImageInput {
  data: string;
  mimeType: string;
  fileName?: string;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

export function parseImageGenerationRequest(value: unknown): ImageGenerationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Image request must be an object");
  const input = value as Record<string, unknown>;
  const supported = new Set(["prompt", "connection", "target", "use_last_attachment", "new_image", "size", "resolution", "quality"]);
  const unknown = Object.keys(input).find((key) => !supported.has(key));
  if (unknown) throw new Error(`Image request field ${unknown} is not supported`);
  const prompt = requiredText(input.prompt, "prompt");
  if (prompt.length > MAX_PROMPT_LENGTH) throw new Error(`prompt must not exceed ${MAX_PROMPT_LENGTH} characters`);
  if (input.use_last_attachment !== undefined && typeof input.use_last_attachment !== "boolean") throw new Error("use_last_attachment must be a boolean");
  if (input.new_image !== undefined && typeof input.new_image !== "boolean") throw new Error("new_image must be a boolean");
  if (input.new_image === true && (input.target !== undefined || input.use_last_attachment === true)) {
    throw new Error("new_image cannot be combined with an edit source");
  }
  return {
    prompt,
    ...(input.connection === undefined ? {} : { connection: requiredText(input.connection, "connection") }),
    ...(input.target === undefined ? {} : { target: requiredText(input.target, "target") }),
    ...(input.use_last_attachment === undefined ? {} : { use_last_attachment: input.use_last_attachment }),
    ...(input.new_image === undefined ? {} : { new_image: input.new_image }),
    ...(input.size === undefined ? {} : { size: requiredText(input.size, "size") }),
    ...(input.resolution === undefined ? {} : { resolution: requiredText(input.resolution, "resolution") }),
    ...(input.quality === undefined ? {} : { quality: requiredText(input.quality, "quality") }),
  };
}

function imageType(bytes: Uint8Array): Pick<ImageFile, "mimeType" | "extension"> | null {
  if (bytes.length >= 24 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (bytes.length >= 10 && bytes[0] === 0xff && bytes[1] === 0xd8) return { mimeType: "image/jpeg", extension: "jpg" };
  if (bytes.length >= 30 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP") {
    return { mimeType: "image/webp", extension: "webp" };
  }
  return null;
}

function checkedImage(bytes: Buffer, fileName: string): ImageFile {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error(`Image ${fileName} exceeds the 20MB limit`);
  const type = imageType(bytes);
  if (!type) throw new Error(`Unsupported image: ${fileName}`);
  const dimensions = getImageDimensions(bytes.toString("base64"), type.mimeType);
  if (!dimensions || dimensions.widthPx <= 0 || dimensions.heightPx <= 0) throw new Error(`Unsupported image: ${fileName}`);
  return { bytes, ...type, width: dimensions.widthPx, height: dimensions.heightPx };
}

async function pathImage(cwd: string, input: string): Promise<ImageFile> {
  const root = await realpath(cwd);
  const resolved = await realpath(path.resolve(cwd, toNativePath(input.replace(/^@/, ""))));
  if (!isPathWithinRoots(resolved, new Set([root]))) throw new Error(`Image path is outside the working directory: ${input}`);
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error(`Image path is not a file: ${input}`);
  if (info.size > MAX_IMAGE_BYTES) throw new Error(`Image ${input} exceeds the 20MB limit`);
  return checkedImage(await readFile(resolved), path.basename(resolved));
}

function base64Image(input: EncodedImageInput, fallbackName: string): ImageFile {
  const length = getBase64DecodedByteLength(input.data);
  if (length === null) throw new Error(`Image ${input.fileName ?? fallbackName} is not valid base64`);
  if (length > MAX_IMAGE_BYTES) throw new Error(`Image ${input.fileName ?? fallbackName} exceeds the 20MB limit`);
  return checkedImage(Buffer.from(input.data, "base64"), input.fileName ?? fallbackName);
}

function latestUserImageAttachment(ctx: RuntimeContext): EncodedImageInput | undefined {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: string; message?: { role?: string; content?: unknown } };
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    if (!Array.isArray(entry.message.content)) return undefined;
    for (const block of entry.message.content) {
      if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "image") continue;
      const image = block as { data?: unknown; mimeType?: unknown };
      if (typeof image.data !== "string" || typeof image.mimeType !== "string") continue;
      return { data: image.data, mimeType: image.mimeType, fileName: "attachment-1" };
    }
    return undefined;
  }
  return undefined;
}

function userMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type?: unknown; text?: unknown } => Boolean(block) && typeof block === "object")
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

function latestMentionedImagePath(ctx: RuntimeContext): string | undefined {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: string; message?: { role?: string; content?: unknown } };
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    return extractMentionedImagePath(userMessageText(entry.message.content));
  }
  return undefined;
}

function latestGeneratedPath(ctx: RuntimeContext): string | undefined {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: string; details?: unknown; customType?: string; message?: { role?: string; details?: unknown } };
    if (entry.type === "custom_message" || entry.customType) {
      const result = getImageGenerationResult(entry.details);
      if (result) return result.path;
    }
    if (entry.type === "message" && entry.message?.role === "toolResult") {
      const result = getImageGenerationResult(entry.message.details);
      if (result) return result.path;
    }
  }
  return undefined;
}

async function saveImage(cwd: string, image: ImageFile): Promise<string> {
  const root = await realpath(cwd);
  let directory = root;
  for (const name of [".pi", "generated-images"]) {
    directory = path.join(directory, name);
    await mkdir(directory, { recursive: true });
    directory = await realpath(directory);
    if (!isPathWithinRoots(directory, new Set([root]))) throw new Error("Generated image directory escapes the working directory");
  }
  const relativePath = path.posix.join(".pi", "generated-images", `image-${randomUUID()}.${image.extension}`);
  await writeFile(path.join(root, ...relativePath.split("/")), image.bytes, { flag: "wx" });
  return relativePath;
}

export async function executeImageGeneration(agentDir: string, rawRequest: unknown, ctx: RuntimeContext, signal?: AbortSignal): Promise<ImageGenerationResult> {
  signal?.throwIfAborted();
  const request = parseImageGenerationRequest(rawRequest);
  const config = resolveImageConfig(agentDir);
  if (!config.enabled) throw new Error("Image generation is disabled");
  const connectionId = request.connection ?? imageConfigView(config).defaultConnection;
  if (!connectionId) throw new Error("No runnable image connection is configured");
  const connection = config.connections[connectionId];
  if (!connection) throw new Error(`Unknown image connection: ${connectionId}`);
  const useImplicitSource = !request.target && !request.new_image;
  const mentioned = useImplicitSource
    ? latestMentionedImagePath(ctx)
    : undefined;
  const attachment = useImplicitSource && !mentioned
    ? latestUserImageAttachment(ctx)
    : undefined;
  const lastGenerated = (useImplicitSource && !request.use_last_attachment && !mentioned && !attachment)
    ? latestGeneratedPath(ctx)
    : undefined;
  const hasInput = Boolean(request.target || request.use_last_attachment || mentioned || attachment || lastGenerated);
  if (hasInput && connection.capabilities.editing !== true) throw new Error(`Image connection ${connectionId} does not declare editing support`);
  if (request.size && !connection.capabilities.sizes?.includes(request.size)) throw new Error(`Image connection ${connectionId} does not support size ${request.size}`);
  if (request.resolution && !connection.capabilities.resolutions?.includes(request.resolution)) throw new Error(`Image connection ${connectionId} does not support resolution ${request.resolution}`);
  if (request.quality && !connection.capabilities.qualities?.includes(request.quality)) throw new Error(`Image connection ${connectionId} does not support quality ${request.quality}`);

  let input: ImageFile | undefined;
  let source: string | undefined;
  if (request.target) {
    input = await pathImage(ctx.cwd, request.target);
    source = request.target;
  } else if (mentioned) {
    input = await pathImage(ctx.cwd, mentioned);
    source = mentioned;
  } else if (attachment) {
    input = base64Image(attachment, "attachment-1");
    source = attachment.fileName ?? "attachment";
  } else if (lastGenerated) {
    input = await pathImage(ctx.cwd, lastGenerated);
    source = lastGenerated;
  }
  if (!input && request.use_last_attachment) throw new Error("No image attachment is available in the current conversation");

  const size = request.size ?? connection.defaults?.size;
  const resolution = request.resolution ?? connection.defaults?.resolution;
  const quality = request.quality ?? connection.defaults?.quality;
  let image: ImageFile;
  const transport = imageConnectionTransport(connection);
  if (transport === "codex") {
    image = checkedImage(await requestCodexImage(connection, ctx, request.prompt, input, size, quality, signal), "generated-image");
  } else if (transport === "antigravity") {
    image = checkedImage(await requestAntigravityImage(connection, ctx, request.prompt, input, size, resolution, signal), "generated-image");
  } else if (transport === "openai-images") {
    image = checkedImage(await requestOpenAIImagesImage(connection, ctx, request.prompt, input, size, quality, signal), "generated-image");
  } else {
    image = checkedImage(await requestXaiImage(connection, ctx, request.prompt, input, size, resolution, quality, signal), "generated-image");
  }
  signal?.throwIfAborted();
  const filePath = await saveImage(ctx.cwd, image);
  return {
    type: IMAGE_RESULT_TYPE,
    version: 1,
    path: filePath,
    mimeType: image.mimeType,
    width: image.width,
    height: image.height,
    prompt: request.prompt,
    connection: connection.id,
    label: connection.label,
    model: connection.model,
    ...(size ? { size } : {}),
    ...(resolution ? { resolution } : {}),
    ...(quality ? { quality } : {}),
    ...(source ? { source } : {}),
  };
}