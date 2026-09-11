import { Buffer } from "node:buffer";
import { getBase64DecodedByteLength } from "./image-attachments";
import { openaiImageSize } from "./image-generation";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 180_000;

export function resolveSub2apiImagesUrl(baseUrl: string | undefined, operation: "generations" | "edits"): string {
  if (!baseUrl?.trim()) throw new Error("No base URL configured for image provider sub2api");
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (normalized.endsWith("/images/generations") || normalized.endsWith("/images/edits")) {
    return `${normalized.slice(0, normalized.lastIndexOf("/"))}/${operation}`;
  }
  if (normalized.endsWith("/images")) return `${normalized}/${operation}`;
  return `${normalized}/images/${operation}`;
}

export function buildSub2apiImageBody(
  model: string,
  prompt: string,
  input: { bytes: Buffer; mimeType: string } | undefined,
  size: string | undefined,
  quality: string | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = { prompt, model };
  const mappedSize = openaiImageSize(size);
  if (mappedSize) body.size = mappedSize;
  if (quality) body.quality = quality;
  if (input) body.images = [{ image_url: `data:${input.mimeType};base64,${input.bytes.toString("base64")}` }];
  return body;
}

function sanitized(value: string, maxLength: number): string {
  return value.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/sk-[A-Za-z0-9._-]+/g, "sk-[redacted]").replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, maxLength);
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
    // Fall through.
  }
  const preview = sanitized(text, 400);
  return preview || undefined;
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

export async function requestSub2apiImage(
  connection: { provider: string; model: string },
  ctx: {
    modelRegistry: {
      getProviderAuth(provider: string): Promise<{ auth: { baseUrl?: string; apiKey?: string } } | undefined>;
      getProvider(provider: string): { baseUrl?: string } | undefined;
    };
  },
  prompt: string,
  input: { bytes: Buffer; mimeType: string } | undefined,
  size: string | undefined,
  quality: string | undefined,
  signal?: AbortSignal,
): Promise<Buffer> {
  const auth = await ctx.modelRegistry.getProviderAuth(connection.provider);
  if (!auth?.auth.apiKey) throw new Error(`No credentials configured for image provider ${connection.provider}`);
  const baseUrl = auth.auth.baseUrl ?? ctx.modelRegistry.getProvider(connection.provider)?.baseUrl;
  const editing = Boolean(input);
  const endpoint = resolveSub2apiImagesUrl(baseUrl, editing ? "edits" : "generations");
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.auth.apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildSub2apiImageBody(connection.model, prompt, input, size, quality)),
    signal: requestSignal,
  });
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
  return Buffer.from(encoded, "base64");
}
