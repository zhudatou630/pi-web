import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { DEFAULT_APP_NAME, parseAppIdentity, readAppIdentity, writeAppIdentity, type AppIdentity } from "@/lib/app-identity";

export const dynamic = "force-dynamic";

function view(identity: AppIdentity) {
  // defaultName: what an empty name falls back to.
  return { ...identity, defaultName: process.env.PI_WEB_APP_NAME?.trim() || DEFAULT_APP_NAME };
}

// GET /api/app-identity — this server's installed-app name and icon (Settings › General).
export async function GET() {
  try {
    return NextResponse.json(view(readAppIdentity()));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

// PUT /api/app-identity  body: { name?, color? } — merged into the saved identity, so tabs editing different fields never undo each other.
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "body must be an object" }, { status: 400 });
  try {
    const identity = parseAppIdentity({ ...readAppIdentity(), ...body });
    if (typeof identity === "string") return NextResponse.json({ error: identity }, { status: 400 });
    writeAppIdentity(identity);
    return NextResponse.json(view(identity));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
