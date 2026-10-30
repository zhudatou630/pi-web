export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class InvalidProviderEntryError extends Error {
  constructor(readonly provider: string, readonly reason: "empty" | "oauthBaseUrl") {
    super(reason === "oauthBaseUrl"
      ? `Provider ${provider}: baseUrl is required when oauth is set`
      : `Provider ${provider}: specify baseUrl, models, headers, compat, apiKey, authHeader or non-empty modelOverrides`);
    this.name = "InvalidProviderEntryError";
  }
}

/** Catalog-independent rules from the SDK's provider composer. */
export function validateProviderEntries(providers: unknown): void {
  if (!isRecord(providers)) return;
  for (const [id, provider] of Object.entries(providers)) {
    if (!isRecord(provider)) continue;
    if (provider.oauth && !provider.baseUrl) throw new InvalidProviderEntryError(id, "oauthBaseUrl");
    // Blank model rows are removed by the store before the SDK sees them.
    const hasModels = Array.isArray(provider.models) && provider.models.some((model) => (
      !isRecord(model) || typeof model.id !== "string" || model.id.trim().length > 0
    ));
    const hasOverrides = isRecord(provider.modelOverrides) && Object.keys(provider.modelOverrides).length > 0;
    if (!hasModels && !hasOverrides && !provider.baseUrl && !provider.headers && !provider.compat
      && !provider.apiKey && !provider.oauth && provider.authHeader === undefined) {
      throw new InvalidProviderEntryError(id, "empty");
    }
  }
}

/** First `provider/model` whose `samplingParams` is not a JSON object. */
export function findInvalidSamplingParams(providers: unknown): string | undefined {
  if (!isRecord(providers)) return;
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!isRecord(provider)) continue;
    const entries: [string, unknown][] = [
      ...(Array.isArray(provider.models) ? provider.models : []).map((model): [string, unknown] => [isRecord(model) ? String(model.id ?? "") : "", model]),
      ...(isRecord(provider.modelOverrides) ? Object.entries(provider.modelOverrides) : []),
    ];
    for (const [id, entry] of entries) {
      if (isRecord(entry) && entry.samplingParams !== undefined && !isRecord(entry.samplingParams)) {
        return `${providerId}/${id}`;
      }
    }
  }
}
