import { NextResponse } from "next/server";
import { renameTag } from "@/lib/notes-store";
import { noteErrorResponse, readNoteBody } from "../errors";

// PATCH /api/notes/tags  body: { from, to } — renames a tag on every note (merges into an existing one).
export async function PATCH(req: Request) {
  try {
    const body = (await readNoteBody(req)) as { from?: unknown; to?: unknown } | null;
    await renameTag(body?.from, body?.to);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return noteErrorResponse(error);
  }
}
