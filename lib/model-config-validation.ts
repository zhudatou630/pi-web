export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
