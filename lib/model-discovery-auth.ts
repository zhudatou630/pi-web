import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * Provider-level endpoint fields a hand-written models.json entry may omit
 * because an extension (or the SDK's catalog) supplies them.
 */
export function inheritedProviderFields(
  provider: Record<string, unknown>,
  registered: { baseUrl?: string; api?: string; name?: string } | undefined,
): Record<string, unknown> {
  const inherited: Record<string, unknown> = {};
  if (!provider.baseUrl && registered?.baseUrl) inherited.baseUrl = registered.baseUrl;
  if (!provider.api && registered?.api) inherited.api = registered.api;
  if (!provider.name && registered?.name) inherited.name = registered.name;
  return inherited;
}

/**
 * Model fields inherited from the composed runtime.
 *
 * A test sandbox holds only the edited provider, so model definitions that lean
 * on the runtime catalog (context window, token limits, provider api) would
 * otherwise fail the SDK's own validation — "baseUrl is required when defining
 * custom models" — and report a broken endpoint for one that works in chat.
 */
const INHERITED_MODEL_KEYS = ["api", "baseUrl", "name", "contextWindow", "maxTokens"] as const;

export function inheritedModelFields<T extends object>(
  model: Record<string, unknown>,
  runtimeModel: T | undefined,
): Record<string, unknown> {
  if (!runtimeModel) return {};
  const source = runtimeModel as Record<string, unknown>;
  return Object.fromEntries(INHERITED_MODEL_KEYS.filter(
    (key) => model[key] === undefined && source[key] !== undefined,
  ).map((key) => [key, source[key]]));
}

export interface ModelDiscoveryAuth {
  apiKey?: string;
  headers: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export async function resolveModelDiscoveryAuth(
  providerName: string,
  provider: Record<string, unknown>,
  registered?: { baseUrl?: string; api?: string; name?: string },
): Promise<ModelDiscoveryAuth> {
  let tempDir: string | undefined;
  try {
    tempDir = mkdtempSync(join(tmpdir(), "pi-web-model-discovery-"));
    const modelsPath = join(tempDir, "models.json");
    const discoveryModelId = "__pi_web_model_discovery__";
    writeFileSync(modelsPath, JSON.stringify({
      providers: {
        [providerName]: {
          ...provider,
          ...inheritedProviderFields(provider, registered),
          models: [{ id: discoveryModelId }],
        },
      },
    }, null, 2), "utf8");

    // Validates the edited entry and resolves its credentials. A provider that
    // is only defined by an extension never reaches this file: the route passes
    // that provider's composed config through `inheritedProviderFields`.
    const modelRuntime = await ModelRuntime.create({ modelsPath });
    const loadError = modelRuntime.getError();
    if (loadError) throw new Error(loadError);
    const model = modelRuntime.getModel(providerName, discoveryModelId);
    if (!model) throw new Error(`Unable to load provider "${providerName}"`);

    const resolved = await modelRuntime.getAuth(model);
    if (resolved) {
      return {
        apiKey: resolved.auth.apiKey,
        headers: stringRecord(resolved.auth.headers),
      };
    }

    return {
      headers: stringRecord(modelRuntime.getCompatibilityRequestConfig(model).headers),
    };
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}
