import { getDebugSnapshot } from "@/lib/debug-snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return Response.json(getDebugSnapshot(), { headers: { "Cache-Control": "no-store" } });
}
