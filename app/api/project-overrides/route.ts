import { NextResponse } from "next/server";
import { basename, dirname, extname } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ProjectOverridesWriteResponse, ProjectResourceGroup, ProjectResourcesResponse } from "@/lib/api-types";
import { getOverrideSyncTargets } from "@/lib/project-override-sync";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  ProjectNotTrustedError,
  RESOURCE_TYPES,
  resolveScopedResources,
  setProjectOverrides,
  type ResourceType,
} from "@/lib/project-resource-overrides";

export const dynamic = "force-dynamic";

function resourceName(path: string): string {
  const file = basename(path);
  if (file === "SKILL.md" || /^index\.(ts|js)$/.test(file)) return basename(dirname(path));
  const ext = extname(file);
  return ext ? file.slice(0, -ext.length) : file;
}

function packageLabel(source: string): string {
  if (source.startsWith("npm:")) return source.slice(4).replace(/@[^@/]+$/, "");
  return basename(source.replace(/@[^@/]+$/, "").replace(/\.git$/, "")) || source;
}

async function cwdAllowed(cwd: string): Promise<boolean> {
  return isExistingFilePathAllowed(cwd, await getAllowedFileRoots());
}

// GET /api/project-overrides?cwd=<path> — every resource pi resolves for cwd, grouped by
// the global package (or top-level scope) it belongs to, with its effective state.
export async function GET(req: Request) {
  const cwd = new URL(req.url).searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
  try {
    if (!(await cwdAllowed(cwd))) return NextResponse.json({ error: "Access denied" }, { status: 403 });
    const [{ resources, trusted }, sync] = await Promise.all([
      resolveScopedResources(cwd, getAgentDir()),
      getOverrideSyncTargets(cwd),
    ]);
    const groups = new Map<string, ProjectResourceGroup>();
    for (const resource of resources) {
      const { origin, scope, source } = resource.owner;
      const groupScope = scope === "project" ? "project" : "global";
      const key = origin === "package" ? `package\0${groupScope}\0${source}` : `top-level\0${groupScope}`;
      let group = groups.get(key);
      if (!group) {
        group = { key, origin, scope: groupScope, source, label: origin === "package" ? packageLabel(source) : "", items: [] };
        groups.set(key, group);
      }
      group.items.push({
        type: resource.type,
        path: resource.path,
        name: resourceName(resource.path),
        enabled: resource.enabled,
        globalEnabled: resource.globalEnabled,
        overridden: resource.override !== "inherit",
        editable: resource.editable,
      });
    }
    return NextResponse.json({
      projectResourcesLoaded: trusted,
      groups: [...groups.values()],
      sync: { kind: sync.kind, otherWorktrees: sync.dirs.length - 1 },
    } satisfies ProjectResourcesResponse);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

// POST /api/project-overrides body: { cwd, enabled, targets: [{ type, path }] }
// Writes `<cwd>/.pi/settings.json` exactly like `pi config --local`, then the same
// change into every other worktree of the repo. Targets are matched against the
// resources pi resolves in each directory; anything else is ignored there.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await req.json() as { cwd?: string; enabled?: unknown; targets?: { type: ResourceType; path: string }[] };
    if (!body.cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
    if (typeof body.enabled !== "boolean") return NextResponse.json({ error: "enabled required" }, { status: 400 });
    const targets = (body.targets ?? []).filter((t) =>
      RESOURCE_TYPES.includes(t?.type) && typeof t.path === "string");
    if (targets.length === 0) return NextResponse.json({ error: "targets required" }, { status: 400 });
    if (!(await cwdAllowed(body.cwd))) return NextResponse.json({ error: "Access denied" }, { status: 403 });

    const agentDir = getAgentDir();
    const { dirs } = await getOverrideSyncTargets(body.cwd);
    await setProjectOverrides(body.cwd, agentDir, targets, body.enabled);
    const failures: ProjectOverridesWriteResponse["failures"] = [];
    for (const dir of dirs.slice(1)) {
      try {
        await setProjectOverrides(dir, agentDir, targets, body.enabled);
      } catch (error) {
        failures.push({ path: dir, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return NextResponse.json({ ok: true, failures } satisfies ProjectOverridesWriteResponse);
  } catch (error) {
    if (error instanceof ProjectNotTrustedError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
