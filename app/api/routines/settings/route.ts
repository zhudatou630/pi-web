import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { RoutineStore } from "@/lib/routines";
import { projectRootForRequest, ProjectRequestError } from "@/lib/project-feature-switch";
import { routineErrorResponse } from "../errors";

export const dynamic = "force-dynamic";

/** With a cwd, the response also carries that project's switch for the routines tools. */
async function settingsResponse(store: RoutineStore, cwd: unknown) {
  const enabled = store.isFeatureEnabled();
  if (cwd === null || cwd === undefined) return { enabled };
  return { enabled, project: store.projectState(await projectRootForRequest(cwd)) };
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof ProjectRequestError) return NextResponse.json({ error: error.message }, { status: error.status });
  return routineErrorResponse(error);
}

// GET /api/routines/settings[?cwd=] — whether the Routines feature is on (Settings › General), and the project's switch.
export async function GET(req: Request) {
  try {
    return NextResponse.json(await settingsResponse(new RoutineStore(), new URL(req.url).searchParams.get("cwd")));
  } catch (error) {
    return errorResponse(error);
  }
}

// PUT /api/routines/settings  body: { enabled: boolean } | { cwd, projectEnabled: boolean }
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await req.json() as { enabled?: unknown; cwd?: unknown; projectEnabled?: unknown } | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "body must be an object" }, { status: 400 });
    const store = new RoutineStore();
    if (body.projectEnabled !== undefined) {
      if (typeof body.projectEnabled !== "boolean") return NextResponse.json({ error: "projectEnabled must be a boolean" }, { status: 400 });
      await store.setProjectEnabled(await projectRootForRequest(body.cwd), body.projectEnabled);
      return NextResponse.json(await settingsResponse(store, body.cwd));
    }
    if (typeof body.enabled !== "boolean") return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
    await store.setFeatureEnabled(body.enabled);
    return NextResponse.json({ enabled: store.isFeatureEnabled() });
  } catch (error) {
    return errorResponse(error);
  }
}
