import { NextResponse } from "next/server";
import { assertImportSource, errorResponse, listImportSources, validateCwd } from "@/lib/subagent-route";
import { importAgentProfiles, listImportableAgentFiles, type ImportScope } from "@/lib/subagents";

export const dynamic = "force-dynamic";

function validateScope(scope: unknown): ImportScope {
  if (scope !== "global" && scope !== "project") throw new Error("scope must be global or project");
  return scope;
}

// GET /api/subagents/profiles/import?cwd=            — { sources }: other known checkouts with agent files.
// GET /api/subagents/profiles/import?cwd=&sourceDir= — { items }: what one of them offers.
export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const cwd = await validateCwd(params.get("cwd"));
    if (!params.has("sourceDir")) return NextResponse.json({ sources: await listImportSources(cwd) });
    const sourceDir = await assertImportSource(cwd, params.get("sourceDir"));
    return NextResponse.json({ items: listImportableAgentFiles(cwd, sourceDir) });
  } catch (error) {
    return errorResponse(error);
  }
}

// POST /api/subagents/profiles/import body: { cwd, sourceDir, scope, files: ["x.md", ...] }
// Byte-copies the picked files into the target scope; existing agents are skipped, never overwritten.
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown; sourceDir?: unknown; scope?: unknown; files?: unknown };
    const cwd = await validateCwd(body.cwd);
    const sourceDir = await assertImportSource(cwd, body.sourceDir);
    const scope = validateScope(body.scope);
    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length === 0) return NextResponse.json({ error: "files required" }, { status: 400 });
    return NextResponse.json({ result: importAgentProfiles(cwd, sourceDir, scope, files) });
  } catch (error) {
    return errorResponse(error);
  }
}
