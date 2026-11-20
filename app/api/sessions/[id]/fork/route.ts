import { NextResponse } from "next/server";
import { getRpcSession, isRpcSessionFileMutationReserved } from "@/lib/rpc-manager";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { forkSessionBranch, forkSessionIntoCwd, getForkLeafId, SessionForkError } from "@/lib/session-fork";
import { allowFileRoot } from "@/lib/file-access";
import { getForkSessionName } from "@/lib/session-display-title";
import { scanSessionFileInfo } from "@/lib/session-list-scanner";
import {
  attachSessionProjectInfo,
  cacheSessionPath,
  invalidateSessionListCache,
  invalidateSessionPathCache,
  resolveSessionPath,
} from "@/lib/session-reader";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

function refusal(status: number, code: string, error: string) {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) return refusal(403, "request-denied", "Untrusted API request");
  if (!hasJsonContentType(req)) return refusal(415, "request-denied", "Content-Type must be application/json");
  const { id } = await params;
  try {
    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return refusal(400, "invalid_request", "Expected a JSON object");
    }
    const targetCwd = "cwd" in body ? body.cwd : undefined;
    const prefix = (body as { prefix?: unknown }).prefix ?? "Fork: ";
    if (prefix !== "Fork: " && prefix !== "分叉：") {
      return refusal(400, "invalid_request", "Invalid fork name prefix");
    }
    if (isRpcSessionFileMutationReserved(id)) return refusal(409, "busy", "Session file is reserved for deletion");
    const opened = getRpcSession(id);
    const sourcePath = (opened?.isAlive() ? opened.sessionFile : "") || await resolveSessionPath(id);
    if (!sourcePath) {
      if (opened?.isAlive()) throw new SessionForkError("unsaved", "This session has not been saved yet. Send a message before forking it.");
      throw new SessionForkError("not_found", "Session not found");
    }
    const source = targetCwd === undefined ? await scanSessionFileInfo(sourcePath) : null;

    // No await between selecting the live/disk leaf and finishing the copy:
    // in-process appends are synchronous, and cannot interleave this snapshot.
    if (isRpcSessionFileMutationReserved(id)) return refusal(409, "busy", "Session file is reserved for deletion");
    const wrapper = getRpcSession(id);
    const currentPath = (wrapper?.isAlive() ? wrapper.sessionFile : "") || sourcePath;
    const fork = targetCwd === undefined
      ? forkSessionBranch(currentPath, getForkLeafId(currentPath, wrapper), source ? getForkSessionName({ ...source, parentSessionId: source.parentSessionPath }, prefix) : undefined)
      : forkSessionIntoCwd(currentPath, targetCwd, prefix, getForkLeafId(currentPath, wrapper));
    cacheSessionPath(fork.sessionId, fork.path);
    invalidateSessionListCache();
    if ("cwd" in fork) allowFileRoot(fork.cwd);

    const info = await scanSessionFileInfo(fork.path);
    if (!info) throw new Error("The forked session could not be read");
    const [session] = await attachSessionProjectInfo([{
      ...info,
      created: info.created.toISOString(),
      modified: info.modified.toISOString(),
      parentSessionId: id,
      relation: { kind: "fork", originSessionId: id },
    }]);
    return NextResponse.json({ sessionId: fork.sessionId, session }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof SessionForkError) {
      if (error.code === "not_found") {
        invalidateSessionPathCache(id);
        invalidateSessionListCache();
      }
      return refusal(error.code === "not_found" ? 404 : error.code === "cwd-invalid" ? 400 : 409, error.code, error.message);
    }
    return refusal(500, "failed", error instanceof Error ? error.message : String(error));
  }
}
