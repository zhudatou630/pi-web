import { stat } from "fs/promises";
import { resolve } from "path";
import { createAgentSessionServices, getAgentDir } from "@earendil-works/pi-coding-agent";
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

export async function createModelsConfigServices(cwd: string) {
  const agentDir = getAgentDir();
  const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
  return createAgentSessionServices({
    cwd,
    agentDir,
    ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
  });
}
