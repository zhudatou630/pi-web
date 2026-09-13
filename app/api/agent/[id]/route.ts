import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { abortSubagent, getSubagentRun, sendSubagentUiMessage, startRpcSession, getRpcSession, isSubagentQueued, setRpcSessionTools } from "@/lib/rpc-manager";

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let commandType: string | undefined;
  let promptAccepted = false;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;
    const requestedToolNames = body.toolNames;
    if (
      requestedToolNames !== undefined
      && (!Array.isArray(requestedToolNames) || requestedToolNames.some((name) => typeof name !== "string"))
    ) {
      throw new Error("toolNames must be an array of strings");
    }
    const toolNames = requestedToolNames as string[] | undefined;
    if (isSubagentQueued(id) && body.type === "abort") {
      await abortSubagent(id);
      return NextResponse.json({ success: true, data: null });
    }
    if (isSubagentQueued(id)) {
      return NextResponse.json({ error: "Subagent is queued" }, { status: 409 });
    }

    if (body.type === "prompt" || body.type === "abort") {
      const subagent = await getSubagentRun(id);
      if (subagent && body.type === "abort") {
        if (subagent.status === "aborted" || subagent.status === "completed" || subagent.status === "failed" || subagent.status === "interrupted") {
          return NextResponse.json({ success: true, data: null });
        }
        await abortSubagent(id);
        return NextResponse.json({ success: true, data: null });
      }
      if (subagent) {
        if (typeof body.message !== "string" || !body.message.trim()) {
          return NextResponse.json({ error: "Subagent message is required", code: "prompt_rejected", accepted: false }, { status: 400 });
        }
        if (Array.isArray(body.images) && body.images.length > 0) {
          return NextResponse.json({ error: "Subagent resume with images is not supported", code: "prompt_rejected", accepted: false }, { status: 400 });
        }
        const result = await sendSubagentUiMessage(id, body.message);
        promptAccepted = true;
        return NextResponse.json({ success: true, data: { subagentAction: result.action, run: result.run } });
      }
    }

    // Fast path: already-running session
    const existing = getRpcSession(id);
    if (body.type === "set_tools") {
      const filePath = existing?.sessionFile || await resolveSessionPath(id) || undefined;
      if (!existing?.isAlive() && !filePath) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      const changed = await setRpcSessionTools(id, filePath, toolNames);
      return NextResponse.json({
        success: true,
        data: { sessionId: changed.sessionId, recreated: changed.recreated },
      });
    }
    if (existing?.isAlive()) {
      const result = await existing.send(body);
      promptAccepted = body.type === "prompt";
      return NextResponse.json({ success: true, data: result });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({
        error: "Session not found",
        ...(body.type === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 404 });
    }

    const { session } = await startRpcSession(id, filePath, undefined, {
      ...(toolNames !== undefined ? { toolNames } : {}),
    });
    const result = await session.send(body);
    promptAccepted = body.type === "prompt";

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: 500 });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    if (isSubagentQueued(id)) {
      return NextResponse.json({ running: true, state: { isStreaming: false, isPromptRunning: true } });
    }
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }

    const state = await session.send({ type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
