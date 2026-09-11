import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Buffer } from "node:buffer";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { getBase64DecodedByteLength } from "./image-attachments";
import { IMAGE_RESULT_TYPE, extractMentionedImagePath, getImageGenerationResult, xaiAspectRatio, type EncodedImageInput, type ImageGenerationRequest, type ImageGenerationResult } from "./image-generation";
import { readImageConfig, type ImageConnection } from "./image-generation-config";
import { isPathWithinRoots } from "./path-security";
import { toNativePath } from "./paths";

const MAX_PROMPT_LENGTH = 32_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_INPUT_IMAGES = 1;
const MAX_INPUT_BYTES = 40 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 180_000;

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
  fileName: string;
  width: number;
  height: number;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((item, index) => requiredText(item, `${name}[${index}]`));
}

function encodedImage(value: unknown, name: string): EncodedImageInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an image`);
  const image = value as Record<string, unknown>;
  return {
    data: requiredText(image.data, `${name}.data`),
    mimeType: requiredText(image.mimeType, `${name}.mimeType`),
    ...(image.fileName === undefined ? {} : { fileName: requiredText(image.fileName, `${name}.fileName`) }),
  };
}

export function parseImageGenerationRequest(value: unknown): ImageGenerationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Image request must be an object");
  const input = value as Record<string, unknown>;
  const prompt = requiredText(input.prompt, "prompt");
  if (prompt.length > MAX_PROMPT_LENGTH) throw new Error(`prompt must not exceed ${MAX_PROMPT_LENGTH} characters`);
  if (input.use_last_attachment !== undefined && typeof input.use_last_attachment !== "boolean") throw new Error("use_last_attachment must be a boolean");
  if (input.new_image !== undefined && typeof input.new_image !== "boolean") throw new Error("new_image must be a boolean");
  if (input.reference_images !== undefined && !Array.isArray(input.reference_images)) throw new Error("reference_images must be an array");
  return {
    prompt,
    ...(input.connection === undefined ? {} : { connection: requiredText(input.connection, "connection") }),
    ...(input.target === undefined ? {} : { target: requiredText(input.target, "target") }),
    ...(input.references === undefined ? {} : { references: stringArray(input.references, "references") }),
    ...(input.use_last_attachment === undefined ? {} : { use_last_attachment: input.use_last_attachment }),
    ...(input.new_image === undefined ? {} : { new_image: input.new_image }),
    ...(input.target_image === undefined ? {} : { target_image: encodedImage(input.target_image, "target_image") }),
    ...(input.reference_images === undefined ? {} : { reference_images: input.reference_images.map((item, index) => encodedImage(item, `reference_images[${index}]`)) }),
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
  return { bytes, fileName: path.extname(fileName) ? fileName : `${fileName}.${type.extension}`, ...type, width: dimensions.widthPx, height: dimensions.heightPx };
}

async function pathImage(cwd: string, input: string, remainingBytes: number): Promise<ImageFile> {
  const root = await realpath(cwd);
  const resolved = await realpath(path.resolve(cwd, toNativePath(input.replace(/^@/, ""))));
  if (!isPathWithinRoots(resolved, new Set([root]))) throw new Error(`Image path is outside the working directory: ${input}`);
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error(`Image path is not a file: ${input}`);
  if (info.size > MAX_IMAGE_BYTES) throw new Error(`Image ${input} exceeds the 20MB limit`);
  if (info.size > remainingBytes) throw new Error("Input images exceed the 40MB combined limit");
  return checkedImage(await readFile(resolved), path.basename(resolved));
}

function base64Image(input: EncodedImageInput, fallbackName: string, remainingBytes: number): ImageFile {
  const length = getBase64DecodedByteLength(input.data);
  if (length === null) throw new Error(`Image ${input.fileName ?? fallbackName} is not valid base64`);
  if (length > MAX_IMAGE_BYTES) throw new Error(`Image ${input.fileName ?? fallbackName} exceeds the 20MB limit`);
  if (length > remainingBytes) throw new Error("Input images exceed the 40MB combined limit");
  return checkedImage(Buffer.from(input.data, "base64"), input.fileName ?? fallbackName);
}

function latestUserImageAttachments(ctx: RuntimeContext): EncodedImageInput[] {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: string; message?: { role?: string; content?: unknown } };
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    if (!Array.isArray(entry.message.content)) return [];
    const images: EncodedImageInput[] = [];
    for (const block of entry.message.content) {
      if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "image") continue;
      const image = block as { data?: unknown; mimeType?: unknown };
      if (typeof image.data !== "string" || typeof image.mimeType !== "string") continue;
      images.push({ data: image.data, mimeType: image.mimeType, fileName: `attachment-${images.length + 1}` });
    }
    return images;
  }
  return [];
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

async function connectionAuth(connection: ImageConnection, ctx: RuntimeContext): Promise<{ baseUrl: string; headers: Record<string, string> }> {
  const auth = await ctx.modelRegistry.getProviderAuth(connection.provider);
  if (!auth) throw new Error(`No credentials configured for image provider ${connection.provider}`);
  const provider = ctx.modelRegistry.getProvider(connection.provider);
  const baseUrl = auth.auth.baseUrl ?? provider?.baseUrl;
  if (!baseUrl) throw new Error(`No base URL configured for image provider ${connection.provider}`);
  const headers = Object.fromEntries(Object.entries(auth.auth.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  if (auth.auth.apiKey && !Object.keys(headers).some((name) => name.toLowerCase() === "authorization")) headers.Authorization = `Bearer ${auth.auth.apiKey}`;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), headers };
}

async function responseBytes(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error("Image API response is too large");
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error("Image API response is too large");
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    signal?.throwIfAborted();
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Image API response is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

function sanitized(value: string, maxLength: number): string {
  return value.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, maxLength);
}

function upstreamError(raw: Buffer): string | undefined {
  const text = raw.toString("utf8");
  try {
    const parsed = JSON.parse(text) as { error?: unknown; code?: unknown; message?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      const code = typeof parsed.code === "string" && parsed.code.trim() ? parsed.code.trim() : undefined;
      return sanitized(code ? `${parsed.error.trim()} (${code})` : parsed.error.trim(), 600);
    }
    if (parsed.error && typeof parsed.error === "object" && !Array.isArray(parsed.error)) {
      const value = parsed.error as { message?: unknown; code?: unknown; type?: unknown };
      const parts = [value.message, value.code, value.type].filter((part): part is string => typeof part === "string" && Boolean(part.trim()));
      if (parts.length) return sanitized(parts.join("; "), 600);
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) return sanitized(parsed.message.trim(), 600);
  } catch {
    // Fall through to a short raw preview.
  }
  const preview = sanitized(text, 400);
  return preview || undefined;
}

async function requestImage(connection: ImageConnection, ctx: RuntimeContext, prompt: string, inputs: ImageFile[], size: string | undefined, resolution: string | undefined, quality: string | undefined, signal?: AbortSignal): Promise<ImageFile> {
  if (connection.provider !== "xai") throw new Error(`Image connection ${connection.id} uses provider ${connection.provider}; only xai is supported`);
  if (inputs.length > 1) throw new Error("Image editing supports one source image");
  const auth = await connectionAuth(connection, ctx);
  const aspectRatio = xaiAspectRatio(size);
  const editing = inputs.length === 1;
  const fields: Record<string, unknown> = {
    model: connection.model,
    prompt,
    n: 1,
    response_format: "b64_json",
    ...(resolution ? { resolution } : {}),
    ...(quality ? { quality } : {}),
  };
  if (editing) {
    const source = inputs[0];
    fields.image = { url: `data:${source.mimeType};base64,${source.bytes.toString("base64")}`, type: "image_url" };
    if (aspectRatio && aspectRatio !== "auto") fields.aspect_ratio = aspectRatio;
  } else if (aspectRatio) {
    fields.aspect_ratio = aspectRatio;
  }
  const headers = new Headers(auth.headers);
  headers.set("Accept", "application/json");
  headers.set("Content-Type", "application/json");
  const body: BodyInit = JSON.stringify(fields);
  const endpoint = `${auth.baseUrl}/images/${editing ? "edits" : "generations"}`;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(endpoint, { method: "POST", headers, body, signal: requestSignal });
  if (!response.ok) {
    const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id");
    const raw = await responseBytes(response, MAX_ERROR_BYTES, requestSignal).catch(() => null);
    const detail = raw ? upstreamError(raw) : undefined;
    throw new Error(`Image API returned HTTP ${response.status}${detail ? `: ${detail}` : ""}${requestId ? ` (request ${sanitized(requestId, 160)})` : ""}`);
  }
  const raw = await responseBytes(response, MAX_RESPONSE_BYTES, requestSignal);
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("Image API returned invalid JSON");
  }
  const encoded = (payload as { data?: Array<{ b64_json?: unknown }> })?.data?.[0]?.b64_json;
  if (typeof encoded !== "string") throw new Error("Image API returned no base64 image");
  const length = getBase64DecodedByteLength(encoded);
  if (length === null) throw new Error("Image API returned invalid base64 image");
  if (length > MAX_IMAGE_BYTES) throw new Error("Generated image exceeds the 20MB limit");
  return checkedImage(Buffer.from(encoded, "base64"), "generated-image");
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
  const config = readImageConfig(agentDir);
  const connectionId = request.connection ?? config.defaultConnection;
  const connection = config.connections[connectionId];
  if (!connection) throw new Error(`Unknown image connection: ${connectionId}`);
  const mentioned = (!request.target && !request.target_image)
    ? latestMentionedImagePath(ctx)
    : undefined;
  const attachments = (!request.target && !request.target_image && !mentioned)
    ? latestUserImageAttachments(ctx)
    : [];
  const lastGenerated = (!request.new_image && !request.target && !request.target_image && !request.use_last_attachment && !mentioned && !attachments.length)
    ? latestGeneratedPath(ctx)
    : null;
  const hasInputs = Boolean(request.target || request.target_image || request.references?.length || request.reference_images?.length || request.use_last_attachment || mentioned || attachments.length || lastGenerated);
  if (connection.provider !== "xai") throw new Error(`Image connection ${connectionId} uses provider ${connection.provider}; only xai is supported`);
  if (hasInputs && connection.capabilities.editing !== true) throw new Error(`Image connection ${connectionId} does not declare editing support`);
  if (request.references?.length || request.reference_images?.length) throw new Error("Image editing supports one source image");
  if (request.size && !connection.capabilities.sizes?.includes(request.size)) throw new Error(`Image connection ${connectionId} does not support size ${request.size}`);
  if (request.resolution && !connection.capabilities.resolutions?.includes(request.resolution)) throw new Error(`Image connection ${connectionId} does not support resolution ${request.resolution}`);
  if (request.quality && !connection.capabilities.qualities?.includes(request.quality)) throw new Error(`Image connection ${connectionId} does not support quality ${request.quality}`);

  const inputs: ImageFile[] = [];
  let inputBytes = 0;
  const addInput = (image: ImageFile) => {
    if (inputs.length >= MAX_INPUT_IMAGES) throw new Error(`At most ${MAX_INPUT_IMAGES} input images are supported`);
    inputBytes += image.bytes.length;
    inputs.push(image);
  };
  const remainingBytes = () => MAX_INPUT_BYTES - inputBytes;
  let source: string | undefined;
  if (request.target) {
    addInput(await pathImage(ctx.cwd, request.target, remainingBytes()));
    source = request.target;
  }
  if (request.target_image) {
    addInput(base64Image(request.target_image, "target", remainingBytes()));
    source = source ?? request.target_image.fileName ?? "attachment";
  }
  if (!inputs.length && mentioned) {
    addInput(await pathImage(ctx.cwd, mentioned, remainingBytes()));
    source = mentioned;
  }
  if (!inputs.length && attachments.length) {
    addInput(base64Image(attachments[0], "attachment-1", remainingBytes()));
    source = attachments[0].fileName ?? "attachment";
  }
  if (!inputs.length && lastGenerated) {
    addInput(await pathImage(ctx.cwd, lastGenerated, remainingBytes()));
    source = lastGenerated;
  }
  if (!inputs.length && request.use_last_attachment) throw new Error("No image attachment is available in the current conversation");

  const size = request.size ?? connection.defaults?.size;
  const resolution = request.resolution ?? connection.defaults?.resolution;
  const quality = request.quality ?? connection.defaults?.quality;
  const image = await requestImage(connection, ctx, request.prompt, inputs, size, resolution, quality, signal);
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
    model: connection.model,
    ...(size ? { size } : {}),
    ...(resolution ? { resolution } : {}),
    ...(quality ? { quality } : {}),
    ...(source ? { source } : {}),
  };
}