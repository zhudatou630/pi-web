import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Buffer } from "node:buffer";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { getBase64DecodedByteLength } from "./image-attachments";
import { requestAntigravityImage, requestGeminiImage } from "./image-generation-antigravity";
import { requestCodexImage } from "./image-generation-codex";
import { requestOpenAIImagesImage } from "./image-generation-openai-images";
import { requestXaiImage } from "./image-generation-xai";
import { IMAGE_RESULT_TYPE, MAX_REFERENCE_IMAGES, imageConnectionTransport, type ImageGenerationRequest, type ImageGenerationResult } from "./image-generation";
import { imageConfigView, resolveImageConfig } from "./image-generation-config";
import { resolveProject } from "./worktree";
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

const REQUEST_FIELDS = ["prompt", "reference_images", "connection", "size", "resolution", "quality"];
const ATTACHMENT_IMAGE = /^attachment:([1-9]\d*)$/;

export function parseImageGenerationRequest(value: unknown): ImageGenerationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Image request must be an object");
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).find((key) => !REQUEST_FIELDS.includes(key));
  if (unknown) throw new Error(`Image request field ${unknown} is not supported. Supported fields: ${REQUEST_FIELDS.join(", ")}`);
  const prompt = requiredText(input.prompt, "prompt");
  if (prompt.length > MAX_PROMPT_LENGTH) throw new Error(`prompt must not exceed ${MAX_PROMPT_LENGTH} characters`);
  const references = input.reference_images;
  if (references !== undefined && (!Array.isArray(references) || references.some((item) => typeof item !== "string" || !item.trim()))) {
    throw new Error("reference_images must be an array of image file paths or attachment:N ([] for a new picture)");
  }
  if (references && references.length > MAX_REFERENCE_IMAGES) {
    throw new Error(`At most ${MAX_REFERENCE_IMAGES} reference images are supported per request`);
  }
  return {
    prompt,
    ...(references?.length ? { reference_images: (references as string[]).map((item) => item.trim()) } : {}),
    ...(input.connection === undefined ? {} : { connection: requiredText(input.connection, "connection") }),
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
  const resolved = await realpath(path.resolve(cwd, toNativePath(input.replace(/^@/, "")))).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    throw new Error(`Image file not found: ${input}. An image the user attached in chat has no file path; reference it as attachment:N instead.`);
  });
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

type ConversationImage = { path: string } | { attachment: EncodedImageInput };

/** Images the user attached on the current branch, oldest first: attachment:1 is the first one. */
function conversationAttachments(ctx: RuntimeContext): EncodedImageInput[] {
  const found: EncodedImageInput[] = [];
  for (const entry of ctx.sessionManager.getBranch() as Array<{ type?: string; message?: { role?: string; content?: unknown } }>) {
    if (entry.type !== "message" || entry.message?.role !== "user" || !Array.isArray(entry.message.content)) continue;
    for (const image of entry.message.content as Array<{ type?: unknown; data?: unknown; mimeType?: unknown } | null>) {
      if (image?.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string") continue;
      found.push({ data: image.data, mimeType: image.mimeType, fileName: `attachment:${found.length + 1}` });
    }
  }
  return found;
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

const PREVIEW_EDGE = 512;

/**
 * A small copy of a generated image for the model's context, so it can check the result and
 * follow "the left one" without reading the file. It stays in every later request of the
 * branch, hence the size cap. Null when the file cannot be read or resized: the image is
 * already saved, so a missing preview must not turn the generation into a failure.
 */
export async function generatedImagePreview(cwd: string, result: Pick<ImageGenerationResult, "path" | "mimeType">): Promise<{ type: "image"; data: string; mimeType: string } | null> {
  try {
    const bytes = await readFile(path.join(await realpath(cwd), ...result.path.split("/")));
    const preview = await resizeImage(bytes, result.mimeType, { maxWidth: PREVIEW_EDGE, maxHeight: PREVIEW_EDGE, maxBytes: 64 * 1024, jpegQuality: 75 });
    return preview ? { type: "image", data: preview.data, mimeType: preview.mimeType } : null;
  } catch {
    return null;
  }
}

/** Store a user-supplied source image under the cwd so a direct edit can target it. */
export async function saveSourceImage(cwd: string, input: EncodedImageInput): Promise<string> {
  return saveImage(cwd, base64Image(input, "source-image"));
}

export interface ImageGenerationOptions {
  /**
   * The model tool names a connection only as a preference: it is tried first, and options it
   * does not declare, missing auth, missing editing support, or quota errors fall through to
   * automatic routing. A connection the user picked in the input-bar dialog stays strict.
   */
  preferConnection?: boolean;
}

export async function executeImageGeneration(agentDir: string, rawRequest: unknown, ctx: RuntimeContext, signal?: AbortSignal, runOptions: ImageGenerationOptions = {}): Promise<ImageGenerationResult> {
  signal?.throwIfAborted();
  const request = parseImageGenerationRequest(rawRequest);
  // One check for the model tool and the composer button, per project: a stale tool or tab cannot bypass it.
  const config = resolveImageConfig(agentDir, (await resolveProject(ctx.cwd)).projectRoot);
  if (!config.enabled) throw new Error("Image generation is disabled in this project");
  const defaultId = imageConfigView(config).defaultConnection;
  const strict = Boolean(request.connection) && !runOptions.preferConnection;
  const preferred = !strict && request.connection && config.connections[request.connection] ? request.connection : undefined;
  const connectionIds = strict
    ? [request.connection as string]
    : [...new Set([preferred, defaultId, ...Object.keys(config.connections)].filter((id): id is string => Boolean(id)))];
  if (!connectionIds[0]) throw new Error("No runnable image connection is configured");
  if (strict && !config.connections[request.connection as string]) {
    throw new Error(`Unknown image connection "${request.connection}". Omit connection to use the default, or use one of: ${Object.keys(config.connections).join(", ")}`);
  }
  const requested = request.reference_images ?? [];
  const attachments = requested.some((item) => ATTACHMENT_IMAGE.test(item)) ? conversationAttachments(ctx) : [];
  const references: ConversationImage[] = requested.map((item) => {
    const match = ATTACHMENT_IMAGE.exec(item);
    if (!match) return { path: item };
    const attachment = attachments[Number(match[1]) - 1];
    if (!attachment) {
      throw new Error(`${item} does not exist: the user attached ${attachments.length} image(s) on this branch, numbered from attachment:1 (the first). If the image is gone, ask the user to attach it again.`);
    }
    return { attachment };
  });
  const hasInput = references.length > 0;
  type Connection = typeof config.connections[string];
  const options = [
    ["size", "sizes", request.size],
    ["resolution", "resolutions", request.resolution],
    ["quality", "qualities", request.quality],
  ] as const;
  const editingError = (connection: Connection) => (
    hasInput && connection.capabilities.editing !== true ? `Image connection ${connection.id} does not declare editing support` : null
  );
  if (strict) {
    // A connection the user picked must honor every requested option.
    const connection = config.connections[request.connection as string];
    const error = editingError(connection) ?? options
      .filter(([, list, value]) => value && !connection.capabilities[list]?.includes(value))
      .map(([name, list, value]) => `Image connection ${connection.id} does not support ${name} ${value}. Declared: ${connection.capabilities[list]?.join(", ") || "none"}; omit ${name} to use its default`)[0];
    if (error) throw new Error(error);
  } else {
    // Automatic routing keeps the user's default connection: an option it does not declare
    // falls back to its own default instead of steering the request to another connection.
    for (const [name, list, value] of options) {
      if (value && !Object.values(config.connections).some((connection) => connection.capabilities[list]?.includes(value))) {
        const declared = [...new Set(Object.values(config.connections).flatMap((connection) => connection.capabilities[list] ?? []))];
        throw new Error(`No configured image connection supports ${name} ${value}. Declared: ${declared.join(", ") || "none"}; omit ${name} to use the default`);
      }
    }
  }

  const inputs = await Promise.all(references.map((reference) => (
    "path" in reference ? pathImage(ctx.cwd, reference.path) : base64Image(reference.attachment, "attachment")
  )));
  const source = references.length
    ? references.map((reference) => ("path" in reference ? reference.path : reference.attachment.fileName)).join(", ")
    : undefined;

  let lastFallbackError: unknown;
  let incompatibleError: string | null = null;
  for (const id of connectionIds) {
    const connection = config.connections[id];
    if (!connection) continue;
    if (!strict && !(await ctx.modelRegistry.getProviderAuth(connection.provider))) continue;
    const error = editingError(connection);
    if (error) {
      incompatibleError ??= error;
      continue;
    }
    const declared = (list: "sizes" | "resolutions" | "qualities", value: string | undefined) => (
      value && connection.capabilities[list]?.includes(value) ? value : undefined
    );
    const size = declared("sizes", request.size) ?? connection.defaults?.size;
    const resolution = declared("resolutions", request.resolution) ?? connection.defaults?.resolution;
    const quality = declared("qualities", request.quality) ?? connection.defaults?.quality;
    try {
      let image: ImageFile;
      const transport = imageConnectionTransport(connection);
      if (transport === "codex") {
        image = checkedImage(await requestCodexImage(connection, ctx, request.prompt, inputs, size, quality, signal), "generated-image");
      } else if (transport === "antigravity") {
        image = checkedImage(await requestAntigravityImage(connection, ctx, request.prompt, inputs, size, resolution, signal), "generated-image");
      } else if (transport === "gemini") {
        image = checkedImage(await requestGeminiImage(connection, ctx, request.prompt, inputs, size, resolution, signal), "generated-image");
      } else if (transport === "openai-images") {
        image = checkedImage(await requestOpenAIImagesImage(connection, ctx, request.prompt, inputs, size, quality, signal), "generated-image");
      } else {
        image = checkedImage(await requestXaiImage(connection, ctx, request.prompt, inputs, size, resolution, quality, signal), "generated-image");
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
    } catch (error) {
      signal?.throwIfAborted();
      if (strict || !(error instanceof Error) || !(/Image API returned HTTP (?:401|402|429)\b/.test(error.message) || /\b(?:quota|rate.?limit|resource.exhausted|insufficient.credits)\b/i.test(error.message))) throw error;
      lastFallbackError = error;
    }
  }
  if (lastFallbackError) throw lastFallbackError;
  if (incompatibleError) throw new Error(incompatibleError);
  throw new Error("No available image connection supports this request");
}