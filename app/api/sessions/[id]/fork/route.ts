import { NextResponse } from "next/server";
import { SessionForkError, forkPersistedSession } from "@/lib/session-fork";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let leafId: string | undefined;
  const raw = await req.text();
  if (raw.trim()) {
    try {
      const body = JSON.parse(raw) as { leafId?: unknown };
      if (body.leafId !== undefined && (typeof body.leafId !== "string" || body.leafId.trim() === "")) {
        return NextResponse.json({ error: "leafId must be a non-empty string", code: "invalid_leaf" }, { status: 400 });
      }
      if (typeof body.leafId === "string") leafId = body.leafId;
    } catch {
      return NextResponse.json({ error: "Invalid JSON", code: "invalid_leaf" }, { status: 400 });
    }
  }

  try {
    const forked = await forkPersistedSession(id, leafId);
    return NextResponse.json({ sessionId: forked.sessionId, path: forked.path });
  } catch (error) {
    if (error instanceof SessionForkError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), code: "failed" },
      { status: 500 },
    );
  }
}
