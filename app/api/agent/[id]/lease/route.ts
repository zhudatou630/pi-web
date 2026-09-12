import { NextResponse } from "next/server";
import {
  acquireSessionLivenessLease,
  renewSessionLivenessLeases,
} from "@/lib/session-liveness";

// POST /api/agent/[id]/lease - Keep an open chat tab's session wrapper alive.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let renewed = renewSessionLivenessLeases(id);
  if (renewed === 0) {
    acquireSessionLivenessLease(id);
    renewed = 1;
  }
  return NextResponse.json({
    success: true,
    renewed,
  }, { headers: { "Cache-Control": "no-store" } });
}
