import { stat } from "fs/promises";
import { join, resolve } from "path";
import { createAgentSessionServices, getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { projectTrustReloadOptions } from "@/lib/project-trust";

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
    ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
  });
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
