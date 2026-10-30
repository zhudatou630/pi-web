import { NextResponse } from "next/server";
import { AgentSessionWrapper, getRpcSession } from "@/lib/rpc-manager";

// POST /api/agent/[id]/lease - Keep an open chat tab's session wrapper alive.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // Existing globalThis wrappers can predate this method during hot reload.
  const session = getRpcSession(id);
  const renewed = session && AgentSessionWrapper.prototype.renewIdleTimer.call(session) ? 1 : 0;
  return NextResponse.json({
    success: true,
    renewed,
  }, { headers: { "Cache-Control": "no-store" } });
}
