import { NextResponse } from "next/server";
import { parseRoutineMemory, RoutineStore } from "@/lib/routines";
import { routineErrorResponse } from "../../errors";

// PUT /api/routines/[id]/memory  body: { memory } — replaces the memory only, apart from the
// definition (PATCH), so a form save never undoes what a run wrote (docs/routines.md, Memory).
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => null) as { memory?: unknown } | null;
    await new RoutineStore().setMemory(id, parseRoutineMemory(body?.memory));
    return NextResponse.json({ success: true });
  } catch (error) {
    return routineErrorResponse(error);
  }
}
