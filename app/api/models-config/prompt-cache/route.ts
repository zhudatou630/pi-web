import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { effectiveAnthropicCacheTtl, writeAnthropicCacheTtl } from "@/lib/prompt-cache-settings";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
}

// GET /api/models-config/prompt-cache — the Anthropic cache TTL requests use now (Settings › Models).
export async function GET() {
  try {
    return NextResponse.json({ anthropicTtl: effectiveAnthropicCacheTtl() });
  } catch (error) {
    return errorResponse(error);
  }
}

// PUT /api/models-config/prompt-cache  body: { anthropicTtl: "5m" | "1h" }
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  const body = await req.json().catch(() => null) as { anthropicTtl?: unknown } | null;
  const ttl = body?.anthropicTtl;
  if (ttl !== "5m" && ttl !== "1h") return NextResponse.json({ error: "anthropicTtl must be \"5m\" or \"1h\"" }, { status: 400 });
  try {
    writeAnthropicCacheTtl(ttl);
    return NextResponse.json({ anthropicTtl: effectiveAnthropicCacheTtl() });
  } catch (error) {
    return errorResponse(error);
  }
}
