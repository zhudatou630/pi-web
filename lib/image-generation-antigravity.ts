import { Buffer } from "node:buffer";
import { getBase64DecodedByteLength } from "./image-attachments";
import { readImageResponseBytes } from "./image-generation-response";

const DEFAULT_ENDPOINTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 180_000;
const RETRY_STATUSES = new Set([403, 404, 429, 500, 502, 503, 504]);

const ASPECT_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]);
const IMAGE_SIZES: Record<string, string> = { "1k": "1K", "2k": "2K" };

export function antigravityAspectRatio(size?: string): string | undefined {
  if (!size) return undefined;
  const value = size.trim();
  if (!value || value === "auto") return undefined;
  if (ASPECT_RATIOS.has(value)) return value;
  throw new Error(`Unsupported image size: ${size}`);
}

export function antigravityImageSize(resolution?: string): string | undefined {
  if (!resolution) return undefined;
  const mapped = IMAGE_SIZES[resolution.trim().toLowerCase()];
  if (mapped) return mapped;
  throw new Error(`Unsupported image resolution: ${resolution}`);
}

export function buildAntigravityImageBody(
  model: string,
  projectId: string,
  prompt: string,
  size?: string,
  resolution?: string,
  input?: { bytes: Buffer; mimeType: string },
): Record<string, unknown> {
  const imageConfig: Record<string, string> = {};
  const aspectRatio = antigravityAspectRatio(size);
  const imageSize = antigravityImageSize(resolution);
  if (aspectRatio) imageConfig.aspectRatio = aspectRatio;
  if (imageSize) imageConfig.imageSize = imageSize;
  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  if (input) parts.push({ inlineData: { mimeType: input.mimeType, data: input.bytes.toString("base64") } });
  return {
    project: projectId,
    model,
    request: {
      contents: [{ role: "user", parts }],
      generationConfig: {
        ...(Object.keys(imageConfig).length ? { imageConfig } : {}),
        candidateCount: 1,
      },
    },
    requestType: "agent",
    userAgent: "antigravity",
    requestId: `agent/${crypto.randomUUID()}/${Date.now()}/${crypto.randomUUID()}/2`,
  };
}

function sanitized(value: string, maxLength: number): string {
  return value.replace(/ya29\.[A-Za-z0-9._-]+/g, "ya29.[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, maxLength);
}

function upstreamError(raw: Buffer): string | undefined {
  const text = raw.toString("utf8");
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (parsed.error && typeof parsed.error === "object" && !Array.isArray(parsed.error)) {
      const value = parsed.error as { message?: unknown; status?: unknown; code?: unknown };
      const parts = [value.message, value.status, value.code]
        .map((part) => typeof part === "string" || typeof part === "number" ? String(part).trim() : "")
        .filter(Boolean);
      if (parts.length) return sanitized(parts.join("; "), 600);
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) return sanitized(parsed.message.trim(), 600);
  } catch {
    // Fall through.
  }
  const preview = sanitized(text, 400);
  return preview || undefined;
}

function antigravityHeaders(token: string): Record<string, string> {
  const platform = process.platform === "darwin" ? "MACOS" : process.platform === "win32" ? "WINDOWS" : "LINUX";
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": "antigravity/hub/2.8.0 (aidev_client; os_type=linux; arch=x64; cl=963137146)",
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": JSON.stringify({ ideType: "ANTIGRAVITY", platform, pluginType: "GEMINI" }),
  };
}

function endpointCandidates(baseUrl?: string): string[] {
  const explicit = baseUrl?.trim();
  if (explicit) return [explicit.replace(/\/+$/, "")];
  const env = process.env.ANTIGRAVITY_BASE_URL?.trim();
  if (env) return [env.replace(/\/+$/, "")];
  return DEFAULT_ENDPOINTS;
}

function packedApiKey(apiKey: string | undefined): { token: string; projectId: string } | undefined {
  if (!apiKey) return undefined;
  try {
    const parsed = JSON.parse(apiKey) as { token?: unknown; projectId?: unknown };
    if (typeof parsed.token !== "string" || !parsed.token || typeof parsed.projectId !== "string" || !parsed.projectId.trim()) return undefined;
    return { token: parsed.token, projectId: parsed.projectId.trim() };
  } catch {
    return undefined;
  }
}

async function antigravityCredentials(
  getProviderAuth: (provider: string) => Promise<{ auth: { apiKey?: string } } | undefined>,
): Promise<{ token: string; projectId: string }> {
  const packed = packedApiKey((await getProviderAuth("antigravity"))?.auth.apiKey);
  if (!packed) throw new Error("No Antigravity credentials. Run /login antigravity first.");
  return packed;
}

async function collectImageFromSse(response: Response, signal: AbortSignal): Promise<Buffer> {
  if (!response.body) throw new Error("Image API returned no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let total = 0;
  let lastError: string | undefined;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error("Image API response is too large");
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const json = line.slice(5).trim();
        if (!json || json === "[DONE]") continue;
        let chunk: {
          error?: { message?: unknown };
          response?: { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: unknown } }> } }> };
          candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: unknown } }> } }>;
        };
        try {
          chunk = JSON.parse(json) as typeof chunk;
        } catch {
          continue;
        }
        if (typeof chunk.error?.message === "string" && chunk.error.message.trim()) lastError = chunk.error.message.trim();
        const data = chunk.response ?? chunk;
        for (const candidate of data.candidates ?? []) {
          for (const part of candidate.content?.parts ?? []) {
            const encoded = part.inlineData?.data;
            if (typeof encoded !== "string") continue;
            const length = getBase64DecodedByteLength(encoded);
            if (length === null) throw new Error("Image API returned invalid base64 image");
            if (length > MAX_IMAGE_BYTES) throw new Error("Generated image exceeds the 20MB limit");
            return Buffer.from(encoded, "base64");
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(lastError ? sanitized(lastError, 600) : "Image API returned no image");
}

export async function requestAntigravityImage(
  connection: { provider: string; model: string },
  ctx: {
    modelRegistry: {
      getProviderAuth(provider: string): Promise<{ auth: { apiKey?: string } } | undefined>;
      getProvider(provider: string): { baseUrl?: string } | undefined;
    };
  },
  prompt: string,
  input: { bytes: Buffer; mimeType: string } | undefined,
  size?: string,
  resolution?: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const { token, projectId } = await antigravityCredentials(ctx.modelRegistry.getProviderAuth);
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const body = JSON.stringify(buildAntigravityImageBody(connection.model, projectId, prompt, size, resolution, input));
  const headers = antigravityHeaders(token);
  let lastError = "no Antigravity image endpoint available";
  for (const endpoint of endpointCandidates(ctx.modelRegistry.getProvider(connection.provider)?.baseUrl)) {
    requestSignal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers,
        body,
        signal: requestSignal,
      });
    } catch (error) {
      lastError = sanitized(error instanceof Error ? error.message : String(error), 400);
      continue;
    }
    if (!response.ok) {
      const raw = await readImageResponseBytes(response, MAX_ERROR_BYTES, requestSignal, "Image API error response is too large").catch(() => Buffer.alloc(0));
      lastError = `Image API returned HTTP ${response.status}${upstreamError(raw) ? `: ${upstreamError(raw)}` : ""}`;
      if (RETRY_STATUSES.has(response.status)) continue;
      throw new Error(lastError);
    }
    return collectImageFromSse(response, requestSignal);
  }
  throw new Error(lastError);
}
