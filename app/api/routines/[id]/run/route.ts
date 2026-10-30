import { NextResponse } from "next/server";
import { startManualRoutineRun } from "@/lib/routine-runner";
import { routineErrorResponse } from "../../errors";

// POST /api/routines/[id]/run — "Run now"; 409 while the previous run is going.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return NextResponse.json({ run: await startManualRoutineRun(id) }, { status: 202 });
  } catch (error) {
    return routineErrorResponse(error);
  }
}
