import { Buffer } from "node:buffer";
import { getPiUserAgent } from "@earendil-works/pi-ai/utils/pi-user-agent";
import { getBase64DecodedByteLength } from "./image-attachments";
import { openaiImageSize } from "./image-generation";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 180_000;

export function codexImageSize(size?: string): string | undefined {
  return openaiImageSize(size);
}

export function resolveCodexImagesUrl(baseUrl: string | undefined, operation: "generations" | "edits"): string {
  const raw = baseUrl && baseUrl.trim() ? baseUrl.trim() : DEFAULT_CODEX_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/images/generations") || normalized.endsWith("/codex/images/edits")) {
    return `${normalized.slice(0, normalized.lastIndexOf("/"))}/${operation}`;
  }
  if (normalized.endsWith("/codex/images")) return `${normalized}/${operation}`;
  if (normalized.endsWith("/codex")) return `${normalized}/images/${operation}`;
  return `${normalized}/codex/images/${operation}`;
}

export function extractCodexAccountId(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid token");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      [JWT_CLAIM_PATH]?: { chatgpt_account_id?: unknown };
    };
    const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
    if (typeof accountId !== "string" || !accountId) throw new Error("No account ID in token");
    return accountId;
  } catch {
    throw new Error("Failed to extract accountId from token");
  }
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

export function buildCodexImageBody(
  model: string,
  prompt: string,
  input: { bytes: Buffer; mimeType: string } | undefined,
  size: string | undefined,
  quality: string | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = { prompt, model };
  const mappedSize = codexImageSize(size);
  if (mappedSize) body.size = mappedSize;
  if (quality) body.quality = quality;
  if (input) body.images = [{ image_url: `data:${input.mimeType};base64,${input.bytes.toString("base64")}` }];
  return body;
}

export async function requestCodexImage(
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
  const token = auth.auth.apiKey;
  const accountId = extractCodexAccountId(token);
  const baseUrl = auth.auth.baseUrl ?? ctx.modelRegistry.getProvider(connection.provider)?.baseUrl;
  const editing = Boolean(input);
  const endpoint = resolveCodexImagesUrl(baseUrl, editing ? "edits" : "generations");
  const headers = new Headers({
    Authorization: `Bearer ${token}`,
    "chatgpt-account-id": accountId,
    originator: "pi",
    "User-Agent": getPiUserAgent(),
    Accept: "application/json",
    "Content-Type": "application/json",
  });
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(buildCodexImageBody(connection.model, prompt, input, size, quality)),
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
