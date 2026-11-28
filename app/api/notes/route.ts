import { NextResponse } from "next/server";
import { createNote, listNotes } from "@/lib/notes-store";
import { noteErrorResponse, readNoteBody } from "./errors";

// GET /api/notes — every note (docs/notes.md).
export async function GET() {
  try {
    return NextResponse.json({ notes: listNotes() });
  } catch (error) {
    return noteErrorResponse(error);
  }
}

// POST /api/notes  body: { text, kind?, tag? }
export async function POST(req: Request) {
  try {
    return NextResponse.json({ note: await createNote(await readNoteBody(req) as Parameters<typeof createNote>[0]) }, { status: 201 });
  } catch (error) {
    return noteErrorResponse(error);
  }
}
