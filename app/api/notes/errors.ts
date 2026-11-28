import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { NOTE_REQUEST_MAX_BYTES, NoteError } from "@/lib/notes-store";

/** The body, bounded before parsing. */
export function readNoteBody(req: Request): Promise<unknown> {
  return parseJsonWithinLimit(req, NOTE_REQUEST_MAX_BYTES);
}

export function noteErrorResponse(error: unknown): NextResponse {
  if (error instanceof NoteError) return NextResponse.json({ error: error.message, ...(error.note ? { note: error.note } : {}) }, { status: error.status });
  if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: error.message }, { status: 413 });
  if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
}
