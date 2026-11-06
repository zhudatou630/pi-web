import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readCodemodeState, writeGlobalCodemode, writeProjectCodemode } from "@/lib/codemode-settings";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getOverrideSyncTargets } from "@/lib/project-override-sync";
import { ProjectNotTrustedError } from "@/lib/project-resource-overrides";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function checkedCwd(cwd: unknown): Promise<string | null> {
  if (cwd === undefined || cwd === null || cwd === "") return null;
  if (typeof cwd !== "string") throw new RequestError("cwd must be a string", 400);
  if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) throw new RequestError("Access denied", 403);
  return cwd;
}

function failure(error: unknown) {
  const status = error instanceof RequestError ? error.status : error instanceof ProjectNotTrustedError ? 403 : 500;
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status });
}

// GET /api/tools/codemode?cwd= — { enabled (global default), project? (effective in cwd) }
export async function GET(req: Request) {
  try {
    const cwd = await checkedCwd(new URL(req.url).searchParams.get("cwd"));
    return NextResponse.json(readCodemodeState(getAgentDir(), cwd));
  } catch (error) {
    return failure(error);
  }
}

// PUT /api/tools/codemode { enabled } — global default; { cwd, projectEnabled } — this project,
// written into every worktree checkout like project overrides (failures reported, not fatal).
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await req.json() as { cwd?: unknown; enabled?: unknown; projectEnabled?: unknown };
    const cwd = await checkedCwd(body.cwd);
    const agentDir = getAgentDir();
    const failures: { path: string; error: string }[] = [];
    if (body.projectEnabled !== undefined) {
      if (typeof body.projectEnabled !== "boolean") return NextResponse.json({ error: "projectEnabled must be a boolean" }, { status: 400 });
      if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
      const { dirs } = await getOverrideSyncTargets(cwd);
      await writeProjectCodemode(cwd, agentDir, body.projectEnabled);
      for (const dir of dirs.slice(1)) {
        try {
          await writeProjectCodemode(dir, agentDir, body.projectEnabled);
        } catch (error) {
          failures.push({ path: dir, error: error instanceof Error ? error.message : String(error) });
        }
      }
    } else if (typeof body.enabled === "boolean") {
      await writeGlobalCodemode(agentDir, body.enabled);
    } else {
      return NextResponse.json({ error: "enabled or projectEnabled must be a boolean" }, { status: 400 });
    }
    return NextResponse.json({ ...readCodemodeState(agentDir, cwd), failures });
  } catch (error) {
    return failure(error);
  }
}
