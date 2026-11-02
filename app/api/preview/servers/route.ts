import { NextResponse, type NextRequest } from "next/server";
import { listDevServers } from "@/lib/dev-servers";

export const dynamic = "force-dynamic";

/** HTTP services listening on this machine's loopback, those started inside `?cwd=` first. */
export async function GET(request: NextRequest) {
  return NextResponse.json({ servers: await listDevServers(request.nextUrl.searchParams.get("cwd")) });
}
