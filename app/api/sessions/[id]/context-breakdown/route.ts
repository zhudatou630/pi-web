import { NextResponse } from "next/server";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { computeContextBreakdown, computeFileContextBreakdown } from "@/lib/context-breakdown";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    // A live wrapper holds the current leaf in memory, including entries not yet flushed.
    const live = getRpcSession(id);
    if (live?.isAlive()) {
      const sm = live.inner.sessionManager;
      return NextResponse.json(computeContextBreakdown(buildSessionContext(sm.getEntries(), sm.getLeafId()).messages));
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    return NextResponse.json(computeFileContextBreakdown(filePath));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
