import { NextResponse } from "next/server";
import { errorResponse, validateCwd } from "@/lib/subagent-route";
import {
  deleteSubagentProfile,
  listSubagentProfileSources,
  saveSubagentProfile,
  setSubagentProfileEnabled,
  setSubagentProjectAvailability,
  type SubagentProfile,
  type SubagentWritableScope,
} from "@/lib/subagents";

export const dynamic = "force-dynamic";

function validateScope(scope: unknown): SubagentWritableScope {
  if (scope !== "global" && scope !== "workspace" && scope !== "project") {
    throw new Error("scope must be global, workspace, or project");
  }
  return scope;
}

export async function GET(req: Request) {
  try {
    const cwd = await validateCwd(new URL(req.url).searchParams.get("cwd"));
    return NextResponse.json({ profiles: listSubagentProfileSources(cwd) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(req: Request) {
  try {
    const body = await req.json() as {
      cwd?: unknown;
      scope?: unknown;
      profile?: Omit<SubagentProfile, "scope" | "filePath">;
    };
    const cwd = await validateCwd(body.cwd);
    const scope = validateScope(body.scope);
    if (!body.profile || typeof body.profile.name !== "string") {
      return NextResponse.json({ error: "profile required" }, { status: 400 });
    }
    return NextResponse.json({ profile: saveSubagentProfile(cwd, scope, body.profile) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown; name?: unknown; enabled?: unknown; projectEnabled?: unknown };
    const cwd = await validateCwd(body.cwd);
    if (typeof body.name !== "string") return NextResponse.json({ error: "name required" }, { status: 400 });
    // projectEnabled is the Project-page switch (available here?); enabled toggles the effective file.
    if (typeof body.projectEnabled === "boolean") {
      if (typeof body.enabled === "boolean") {
        return NextResponse.json({ error: "enabled and projectEnabled are mutually exclusive" }, { status: 400 });
      }
      setSubagentProjectAvailability(cwd, body.name, body.projectEnabled);
      return NextResponse.json({ ok: true });
    }
    if (typeof body.enabled !== "boolean") return NextResponse.json({ error: "enabled required" }, { status: 400 });
    setSubagentProfileEnabled(cwd, body.name, body.enabled);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown; scope?: unknown; name?: unknown };
    const cwd = await validateCwd(body.cwd);
    const scope = validateScope(body.scope);
    if (typeof body.name !== "string") return NextResponse.json({ error: "name required" }, { status: 400 });
    deleteSubagentProfile(cwd, scope, body.name);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
