import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  isProjectSubagentsDisabled,
  MAX_SUBAGENT_MAX_CONCURRENT,
  readSubagentSettings,
  writeBuiltInSubagentsEnabled,
  writeProjectSubagentsEnabled,
  writeSubagentMaxConcurrent,
} from "@/lib/subagent-settings";
import { resolveProject } from "@/lib/worktree";
import type { SubagentSettingsResponse } from "@/lib/api-types";

export const dynamic = "force-dynamic";

class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** The per-project switch is keyed by the sidebar project root, so worktrees share it. */
async function projectRootFor(cwd: unknown): Promise<string> {
  if (typeof cwd !== "string" || !cwd || !existsSync(cwd)) throw new RequestError("Valid cwd required", 400);
  if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) throw new RequestError("Access denied", 403);
  return (await resolveProject(cwd)).projectRoot;
}

async function respond(cwd: unknown) {
  const settings = readSubagentSettings();
  const body: SubagentSettingsResponse = { enabled: settings.builtInEnabled, maxConcurrent: settings.maxConcurrent };
  if (cwd !== null && cwd !== undefined) {
    const root = await projectRootFor(cwd);
    body.project = { root, enabled: !isProjectSubagentsDisabled(root) };
  }
  return NextResponse.json(body);
}

function failure(error: unknown) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: error instanceof RequestError ? error.status : 500 },
  );
}

export async function GET(req: Request) {
  try {
    return await respond(new URL(req.url).searchParams.get("cwd"));
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as { enabled?: unknown; maxConcurrent?: unknown; cwd?: unknown; projectEnabled?: unknown };
    if (body.enabled === undefined && body.maxConcurrent === undefined && body.projectEnabled === undefined) {
      return NextResponse.json({ error: "enabled, maxConcurrent, or projectEnabled is required" }, { status: 400 });
    }
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
    }
    if (body.projectEnabled !== undefined && typeof body.projectEnabled !== "boolean") {
      return NextResponse.json({ error: "projectEnabled must be a boolean" }, { status: 400 });
    }
    if (body.maxConcurrent !== undefined && (
      typeof body.maxConcurrent !== "number"
      || !Number.isInteger(body.maxConcurrent)
      || body.maxConcurrent < 1
      || body.maxConcurrent > MAX_SUBAGENT_MAX_CONCURRENT
    )) {
      return NextResponse.json({ error: `maxConcurrent must be an integer between 1 and ${MAX_SUBAGENT_MAX_CONCURRENT}` }, { status: 400 });
    }
    if (body.projectEnabled !== undefined) {
      writeProjectSubagentsEnabled(await projectRootFor(body.cwd), body.projectEnabled);
    }
    if (body.enabled !== undefined) writeBuiltInSubagentsEnabled(body.enabled);
    if (body.maxConcurrent !== undefined) writeSubagentMaxConcurrent(body.maxConcurrent);
    return await respond(body.cwd);
  } catch (error) {
    return failure(error);
  }
}
