import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { RoutineStore } from "@/lib/routines";
import { routineErrorResponse } from "../errors";

export const dynamic = "force-dynamic";

// GET /api/routines/settings — whether the Routines feature is on (Settings › General).
export async function GET() {
  try {
    return NextResponse.json({ enabled: new RoutineStore().isFeatureEnabled() });
  } catch (error) {
    return routineErrorResponse(error);
  }
}

// PUT /api/routines/settings  body: { enabled: boolean }
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await req.json() as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
    const store = new RoutineStore();
    await store.setFeatureEnabled(body.enabled);
    return NextResponse.json({ enabled: store.isFeatureEnabled() });
  } catch (error) {
    return routineErrorResponse(error);
  }
}
