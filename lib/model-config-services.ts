import { stat } from "fs/promises";
import { join, resolve } from "path";
import { createAgentSessionServices, getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getProjectTrustStatus, projectTrustReloadOptions } from "@/lib/project-trust";
import { llamaCppExtension } from "@/lib/builtin-extensions";
import { getModelsCacheGeneration } from "@/lib/models-cache";

export async function resolveAllowedCwd(requestedCwd: string): Promise<
  { cwd: string } | { error: string; status: number }
> {
  const cwd = resolve(requestedCwd);
  try {
    const cwdStat = await stat(cwd);
    if (!cwdStat.isDirectory()) return { error: `Not a directory: ${cwd}`, status: 400 };
  } catch {
    return { error: `Directory does not exist: ${cwd}`, status: 400 };
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return { error: "Access denied", status: 403 };
  }
  return { cwd };
}

/** Optional `cwd` on the query string; falls back to the global agent directory. */
export async function resolveOptionalCwd(
  requestedCwd: string | null,
): Promise<{ cwd: string } | { error: string; status: number }> {
  if (!requestedCwd) return { cwd: getAgentDir() };
  return resolveAllowedCwd(requestedCwd);
}

export async function createModelsConfigServices(cwd: string) {
  const agentDir = getAgentDir();
  const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
  return createAgentSessionServices({
    cwd,
    agentDir,
    resourceLoaderOptions: { extensionFactories: [llamaCppExtension] },
    ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
  });
}

type ConfigServices = Awaited<ReturnType<typeof createModelsConfigServices>>;
interface ReadServicesEntry {
  promise: Promise<ConfigServices>;
  expiresAt: number;
}

declare global {
  var __piModelsConfigReadServices: Map<string, ReadServicesEntry> | undefined;
}

// Building the services imports every extension (seconds with many, blocking the event loop), so keep it rare.
// Config file changes rebuild at once through the key below.
// shortcut: extension source edited outside Pi Web shows within an hour; add file watching if it must be immediate.
const READ_SERVICES_TTL_MS = 60 * 60_000;
const READ_SERVICES_TIMEOUT_MS = 30_000;
const MAX_READ_SERVICES = 8;

/** Read paths only: login/logout and settings writes must keep their own services. */
export async function getModelsConfigReadServices(cwd: string): Promise<ConfigServices> {
  cwd = resolve(cwd);
  const agentDir = getAgentDir();
  const generation = getModelsCacheGeneration();
  const trust = getProjectTrustStatus(cwd, agentDir);
  // Rebuild on file changes instead of refreshing a shared mutable runtime under readers.
  const files = ["auth.json", "models.json", "models-store.json", "settings.json"]
    .map((file) => join(agentDir, file));
  files.push(join(cwd, ".pi", "settings.json"));
  const versions = await Promise.all(files.map(async (file) => {
    try {
      const info = await stat(file, { bigint: true });
      return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }));
  const key = JSON.stringify([agentDir, cwd, trust, generation, versions]);
  const cache = globalThis.__piModelsConfigReadServices ??= new Map();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.promise;
  }
  for (const [oldKey, entry] of cache) {
    if (entry.expiresAt <= Date.now()) cache.delete(oldKey);
  }
  while (cache.size >= MAX_READ_SERVICES) cache.delete(cache.keys().next().value!);

  let timer: ReturnType<typeof setTimeout>;
  const entry: ReadServicesEntry = {
    expiresAt: Date.now() + READ_SERVICES_TTL_MS,
    promise: Promise.race([
      createModelsConfigServices(cwd).then((services) => {
        const runtime = services.modelRuntime;
        const getAvailable = runtime.getAvailable.bind(runtime);
        let queue = Promise.resolve();
        // SDK availability reads mutate a shared snapshot and supersede overlapping refreshes.
        runtime.getAvailable = (...args) => {
          const read = queue.then(() => getAvailable(...args));
          queue = read.then(() => {}, () => {});
          return read;
        };
        return services;
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Model configuration services timed out")), READ_SERVICES_TIMEOUT_MS);
      }),
    ]).catch((error) => {
      if (cache.get(key) === entry) cache.delete(key);
      throw error;
    }).finally(() => clearTimeout(timer)),
  };
  cache.set(key, entry);
  return entry.promise;
}

/**
 * `provider/id` of every model Pi ships, before models.json is applied: the
 * static catalog plus the cached pi.dev overlay, the same base the runtime
 * composes over. A models.json definition with one of these ids replaces the
 * shipped model whole, so the panel uses this to say so.
 */
export async function builtInModelRefs(): Promise<string[]> {
  const agentDir = getAgentDir();
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    // A path with no file loads an empty config but keeps the file-backed catalog cache.
    modelsPath: join(agentDir, ".pi-web-no-models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
  });
  return runtime.getModels().map((model) => `${model.provider}/${model.id}`);
}
