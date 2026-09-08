export type ModelEntry = {
  id: string;
  name: string;
  provider: string;
  input?: string[];
};

export type ModelsResponse = {
  models: Record<string, string>;
  modelList?: ModelEntry[];
  defaultModel?: { provider: string; modelId: string } | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
  thinkingLevelPins?: Record<string, string>;
  modelError?: string;
  modelScopeWarnings?: string[];
};

type CacheEntry = {
  data: ModelsResponse;
  loadedAt: number;
};

type PendingLoad = {
  promise: Promise<ModelsResponse>;
  forced: boolean;
  refreshToken?: number;
};

const MODELS_CLIENT_CACHE_TTL_MS = 60_000;
const MAX_MODELS_CLIENT_CACHE_ENTRIES = 32;
const entries = new Map<string, CacheEntry>();
const inFlight = new Map<string, PendingLoad>();

export function peekModelsClientCache(key: string): ModelsResponse | undefined {
  return entries.get(key)?.data;
}

export function loadModelsWithClientCache(
  key: string,
  loader: () => Promise<ModelsResponse>,
  options: { force?: boolean; refreshToken?: number } = {},
): Promise<ModelsResponse> {
  const cached = entries.get(key);
  if (!options.force && cached && cached.loadedAt + MODELS_CLIENT_CACHE_TTL_MS > Date.now()) {
    return Promise.resolve(cached.data);
  }

  const pending = inFlight.get(key);
  if (
    pending
    && (
      !options.force
      || (pending.forced && pending.refreshToken === options.refreshToken)
    )
  ) return pending.promise;

  const waitForPending = pending
    ? pending.promise.catch(() => undefined)
    : Promise.resolve();
  const promise = waitForPending
    .then(loader)
    .then((data) => {
      if (data.modelError && (data.modelList?.length ?? 0) === 0) {
        throw new Error(data.modelError);
      }
      entries.delete(key);
      entries.set(key, { data, loadedAt: Date.now() });
      while (entries.size > MAX_MODELS_CLIENT_CACHE_ENTRIES) {
        const oldestKey = entries.keys().next().value;
        if (oldestKey === undefined) break;
        entries.delete(oldestKey);
      }
      return data;
    })
    .finally(() => {
      if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
    });

  inFlight.set(key, {
    promise,
    forced: options.force === true,
    ...(options.refreshToken !== undefined ? { refreshToken: options.refreshToken } : {}),
  });
  return promise;
}
