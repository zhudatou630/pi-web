import { NextResponse } from "next/server";
import { homedir } from "os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { BUILTIN_EXTENSION_NAMES, BUILTIN_EXTENSION_PREFIX } from "@/lib/builtin-extensions";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import {
  MCP_EXPOSURES,
  McpConfigError,
  mcpProjectEntryKind,
  readMcpServerEntry,
  readMcpSettings,
  removeMcpOverride,
  removeMcpServer,
  saveMcpServer,
  updateMcpServer,
  type McpExposure,
  type McpScope,
} from "@/lib/mcp-config";
import { getOverrideSyncTargets, MCP_CONFIG } from "@/lib/project-override-sync";
import { ProjectNotTrustedError, setGlobalResourceEnabled } from "@/lib/project-resource-overrides";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

async function cwdAllowed(cwd: string | null): Promise<boolean> {
  return !cwd || isExistingFilePathAllowed(cwd, await getAllowedFileRoots());
}

function failure(error: unknown) {
  const status = error instanceof ProjectNotTrustedError ? 403 : error instanceof McpConfigError ? 400 : 500;
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status });
}

/**
 * Overrides of global servers are project settings, so like project overrides they go to every
 * worktree checkout (unless .pi/mcp.json is tracked). Failures are reported, not fatal.
 */
async function syncOverride(cwd: string, write: (dir: string) => Promise<void>): Promise<{ path: string; error: string }[]> {
  const failures: { path: string; error: string }[] = [];
  const { dirs } = await getOverrideSyncTargets(cwd, MCP_CONFIG);
  for (const dir of dirs.slice(1)) {
    try {
      await write(dir);
    } catch (error) {
      failures.push({ path: dir, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return failures;
}

/** Shared guard for writes; returns the parsed body or a response to send. */
async function readWrite(req: Request): Promise<Record<string, unknown> | NextResponse> {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  const body = await req.json() as Record<string, unknown>;
  const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : null;
  if (!(await cwdAllowed(cwd))) return NextResponse.json({ error: "Access denied" }, { status: 403 });
  if (body.scope !== undefined && body.scope !== "global" && body.scope !== "project") {
    return NextResponse.json({ error: "scope must be global or project" }, { status: 400 });
  }
  if (body.scope === "project" && !cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
  return { ...body, cwd };
}

// GET /api/mcp?cwd=<path> — configured servers of the global and (with cwd) project mcp.json, secrets left out.
// GET /api/mcp?cwd=&scope=&name= — that entry as written, for "Edit JSON".
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const cwd = params.get("cwd");
  const scope = params.get("scope");
  const name = params.get("name");
  try {
    if (!(await cwdAllowed(cwd))) return NextResponse.json({ error: "Access denied" }, { status: 403 });
    if (name !== null) {
      if (scope !== "global" && scope !== "project") return NextResponse.json({ error: "scope must be global or project" }, { status: 400 });
      return NextResponse.json({ config: await readMcpServerEntry({ cwd, scope, name }) });
    }
    return NextResponse.json(await readMcpSettings(cwd));
  } catch (error) {
    return failure(error);
  }
}

// PUT /api/mcp { cwd?, scope, name, config, previousName? } — add or replace one server.
export async function PUT(req: Request) {
  try {
    const body = await readWrite(req);
    if (body instanceof NextResponse) return body;
    if (typeof body.name !== "string" || !body.scope) return NextResponse.json({ error: "scope and name required" }, { status: 400 });
    await saveMcpServer({
      cwd: body.cwd as string | null,
      scope: body.scope as McpScope,
      name: body.name,
      config: body.config,
      ...(typeof body.previousName === "string" ? { previousName: body.previousName } : {}),
    });
    return NextResponse.json(await readMcpSettings(body.cwd as string | null));
  } catch (error) {
    return failure(error);
  }
}

// PATCH /api/mcp { cwd?, scope, name, enabled?, exposure?, toolExposure?, override? } — the switches pi's /mcp manager
// changes, plus per-tool rules (`toolExposure: { tool: exposure | null }`, null deletes that key).
// `override: true` (project scope) writes a project override of the global server instead.
// PATCH /api/mcp { cwd?, builtin, enabled } — load a built-in extension globally (`-builtin:<name>`).
export async function PATCH(req: Request) {
  try {
    const body = await readWrite(req);
    if (body instanceof NextResponse) return body;
    const cwd = body.cwd as string | null;
    if (body.builtin !== undefined) {
      if (!(BUILTIN_EXTENSION_NAMES as readonly unknown[]).includes(body.builtin) || typeof body.enabled !== "boolean") {
        return NextResponse.json({ error: "unknown built-in extension or missing enabled" }, { status: 400 });
      }
      await setGlobalResourceEnabled(cwd ?? homedir(), getAgentDir(), {
        type: "extensions",
        path: `${BUILTIN_EXTENSION_PREFIX}${body.builtin}`,
      }, body.enabled);
      return NextResponse.json(await readMcpSettings(cwd));
    }
    if (typeof body.name !== "string" || !body.scope) return NextResponse.json({ error: "scope and name required" }, { status: 400 });
    // null (with override) drops the project override's `enabled`, following global again.
    if (body.enabled !== undefined && typeof body.enabled !== "boolean" && !(body.enabled === null && body.override === true)) {
      return NextResponse.json({ error: "enabled must be boolean, or null with override" }, { status: 400 });
    }
    if (body.exposure !== undefined && !(MCP_EXPOSURES as readonly unknown[]).includes(body.exposure)) {
      return NextResponse.json({ error: `exposure must be one of ${MCP_EXPOSURES.join(", ")}` }, { status: 400 });
    }
    const toolExposure = body.toolExposure;
    if (toolExposure !== undefined && (
      typeof toolExposure !== "object" || toolExposure === null || Array.isArray(toolExposure)
      || Object.entries(toolExposure).some(([tool, exposure]) => !tool || (exposure !== null && !(MCP_EXPOSURES as readonly unknown[]).includes(exposure)))
    )) {
      return NextResponse.json({ error: `toolExposure values must be null or one of ${MCP_EXPOSURES.join(", ")}` }, { status: 400 });
    }
    const update = {
      scope: body.scope as McpScope,
      name: body.name,
      ...(body.enabled !== undefined ? { enabled: body.enabled as boolean | null } : {}),
      ...(body.exposure !== undefined ? { exposure: body.exposure as McpExposure } : {}),
      ...(toolExposure !== undefined ? { toolExposure: toolExposure as Record<string, McpExposure | null> } : {}),
      ...(body.override === true ? { override: true } : {}),
    };
    await updateMcpServer({ cwd, ...update });
    const failures = update.override && cwd ? await syncOverride(cwd, async (dir) => {
      // A checkout that defines its own server of this name keeps it.
      if (mcpProjectEntryKind(dir, update.name) !== "server") await updateMcpServer({ cwd: dir, ...update });
    }) : [];
    return NextResponse.json({ ...(await readMcpSettings(cwd)), failures });
  } catch (error) {
    return failure(error);
  }
}

// DELETE /api/mcp { cwd?, scope, name } — stored OAuth credentials are kept, like `pi mcp remove`.
export async function DELETE(req: Request) {
  try {
    const body = await readWrite(req);
    if (body instanceof NextResponse) return body;
    if (typeof body.name !== "string" || !body.scope) return NextResponse.json({ error: "scope and name required" }, { status: 400 });
    const cwd = body.cwd as string | null;
    const name = body.name;
    const override = body.scope === "project" && cwd !== null && mcpProjectEntryKind(cwd, name) === "override";
    await removeMcpServer({ cwd, scope: body.scope as McpScope, name });
    const failures = override ? await syncOverride(cwd, (dir) => removeMcpOverride(dir, name)) : [];
    return NextResponse.json({ ...(await readMcpSettings(cwd)), failures });
  } catch (error) {
    return failure(error);
  }
}
