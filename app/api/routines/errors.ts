import { NextResponse } from "next/server";
import { RoutineError } from "@/lib/routines";

export function routineErrorResponse(error: unknown): NextResponse {
  if (error instanceof RoutineError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
}
