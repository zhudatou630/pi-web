import { Buffer } from "node:buffer";
import { getBase64DecodedByteLength } from "./image-attachments";
import { readImageResponseBytes } from "./image-generation-response";
import { xaiAspectRatio, type ImageConnectionView } from "./image-generation";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 180_000;

type XaiRuntimeContext = {
  modelRegistry: {
    getProviderAuth(provider: string): Promise<{ auth: { baseUrl?: string; apiKey?: string; headers?: Record<string, unknown> } } | undefined>;
    getProvider(provider: string): { baseUrl?: string } | undefined;
  };
};

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

async function connectionAuth(connection: ImageConnectionView, ctx: XaiRuntimeContext): Promise<{ baseUrl: string; headers: Record<string, string> }> {
  const auth = await ctx.modelRegistry.getProviderAuth(connection.provider);
  if (!auth) throw new Error(`No credentials configured for image provider ${connection.provider}`);
  const provider = ctx.modelRegistry.getProvider(connection.provider);
  const baseUrl = auth.auth.baseUrl ?? provider?.baseUrl;
  if (!baseUrl) throw new Error(`No base URL configured for image provider ${connection.provider}`);
  const headers = Object.fromEntries(Object.entries(auth.auth.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  if (auth.auth.apiKey && !Object.keys(headers).some((name) => name.toLowerCase() === "authorization")) headers.Authorization = `Bearer ${auth.auth.apiKey}`;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), headers };
}

export async function requestXaiImage(
  connection: ImageConnectionView,
  ctx: XaiRuntimeContext,
  prompt: string,
  input: { bytes: Buffer; mimeType: string } | undefined,
  size: string | undefined,
  resolution: string | undefined,
  quality: string | undefined,
  signal?: AbortSignal,
): Promise<Buffer> {
  const auth = await connectionAuth(connection, ctx);
  const aspectRatio = xaiAspectRatio(size);
  const editing = Boolean(input);
  const fields: Record<string, unknown> = {
    model: connection.model,
    prompt,
    n: 1,
    response_format: "b64_json",
    ...(resolution ? { resolution } : {}),
    ...(quality ? { quality } : {}),
  };
  if (editing) {
    const source = input as { bytes: Buffer; mimeType: string };
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
    const raw = await readImageResponseBytes(response, MAX_ERROR_BYTES, requestSignal).catch(() => null);
    const detail = raw ? upstreamError(raw) : undefined;
    throw new Error(`Image API returned HTTP ${response.status}${detail ? `: ${detail}` : ""}${requestId ? ` (request ${sanitized(requestId, 160)})` : ""}`);
  }
  const raw = await readImageResponseBytes(response, MAX_RESPONSE_BYTES, requestSignal);
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
