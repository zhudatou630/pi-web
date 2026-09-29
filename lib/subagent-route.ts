import { existsSync } from "fs";
import { NextResponse } from "next/server";
import { basename } from "path";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "./file-access";
import { samePath } from "./paths";
import { ProjectNotTrustedError } from "./project-resource-overrides";
import { listAllSessions } from "./session-reader";
import { countImportableAgentFiles } from "./subagents";

/** Shared by the /api/subagents/profiles routes. */
export async function validateCwd(cwd: unknown): Promise<string> {
  if (typeof cwd !== "string" || !cwd || !existsSync(cwd)) throw new Error("Valid cwd required");
  if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) throw new Error("Access denied");
  return cwd;
}

export function errorResponse(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof ProjectNotTrustedError || message === "Access denied" ? 403
    : message === "Agent profile not found" ? 404
    : 400;
  return NextResponse.json({ error: message }, { status });
}

export interface ImportSource {
  dir: string;
  name: string;
  count: number;
}

/** Other checkouts known from session history that have agent definitions to copy. */
export async function listImportSources(cwd: string): Promise<ImportSource[]> {
  const dirs = new Set<string>();
  for (const session of await listAllSessions()) {
    for (const dir of [session.cwd, session.projectRoot]) if (dir && !samePath(dir, cwd)) dirs.add(dir);
  }
  return [...dirs]
    .map((dir) => ({ dir, name: basename(dir), count: existsSync(dir) ? countImportableAgentFiles(dir) : 0 }))
    .filter((source) => source.count > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The source must be one of the listed checkouts; the import never reads arbitrary folders. */
export async function assertImportSource(cwd: string, sourceDir: unknown): Promise<string> {
  if (typeof sourceDir !== "string" || !sourceDir) throw new Error("sourceDir required");
  const source = (await listImportSources(cwd)).find((item) => samePath(item.dir, sourceDir));
  if (!source) throw new Error("Access denied");
  return source.dir;
}
