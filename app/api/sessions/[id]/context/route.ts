import { NextResponse } from "next/server";
import { resolveSessionPath, buildSessionContext, openSessionForRead } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { jsonResponse } from "@/lib/json-response";
import { routineNameLookup } from "@/lib/routines";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;
  const deferThinking = url.searchParams.has("deferThinking");
  const deferToolResultImages = url.searchParams.has("deferMedia");
  // `tail` caps the ancestor chain returned; `before` rewinds the walk start to
  // an older entry so the client can page upward without re-fetching the whole
  // active branch.
  //
  // The default is 200 rather than 50 because the window size is not what the
  // read costs: the enclosing open parses the whole JSONL either way. A 50-entry
  // window pays that full parse but returns only about six turns of a tool-heavy
  // session, which quadruples the upward paging round trips for no saving. 200
  // returns ~25 turns for the same read and is also what the minimap can map.
  const rawTail = Number(url.searchParams.get("tail"));
  const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 200;
  const before = url.searchParams.get("before") ?? undefined;

  try {
    const rpc = getRpcSession(id);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const filePath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = liveRpc?.inner.sessionManager ?? openSessionForRead(filePath!);
    // `before` is the oldest entry already on the client; fetch its ancestors
    // only (excludeLeaf) so prepending the page does not duplicate `before`.
    const context = {
      ...buildSessionContext(sm.getEntries() as never, before ?? leafId, {
        deferThinking,
        deferToolResultImages,
        tail,
        excludeLeaf: Boolean(before),
        sessionId: id,
        routineName: routineNameLookup(),
      }),
      ...liveRpc?.liveSelection?.(), // optional: wrappers from before a hot reload lack it
    };

    return await jsonResponse(req, { context, tail, before: before ?? null });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
