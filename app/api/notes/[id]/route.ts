import { NextResponse } from "next/server";
import { deleteNote, NoteError, updateNote } from "@/lib/notes-store";
import { noteErrorResponse, readNoteBody } from "../errors";

// PATCH /api/notes/[id]  body: { text?, kind?, tag?, baseUpdatedAt }; 409 { note } when changed elsewhere.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return NextResponse.json({ note: await updateNote(id, await readNoteBody(req) as Parameters<typeof updateNote>[1]) });
  } catch (error) {
    return noteErrorResponse(error);
  }
}

// DELETE /api/notes/[id]?baseUpdatedAt=N — with the version, a note saved elsewhere since is kept (409).
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const raw = new URL(req.url).searchParams.get("baseUpdatedAt");
    const base = raw === null ? undefined : Number(raw);
    if (base !== undefined && !Number.isFinite(base)) throw new NoteError("baseUpdatedAt must be a number", 400);
    await deleteNote(id, undefined, base);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return noteErrorResponse(error);
  }
}
