import { NextResponse } from "next/server";
import { nextRunAt, parseRoutineInput, RoutineStore } from "@/lib/routines";
import { isRoutineSchedulerEnabled } from "@/lib/routine-scheduler-flag";
import { routineErrorResponse } from "./errors";
import { assertRoutineTargetExists } from "./target";

// GET /api/routines — every routine with its next run time and recent runs.
export async function GET() {
  try {
    const now = new Date();
    const routines = new RoutineStore().list().map((routine) => ({
      ...routine,
      nextRunAt: nextRunAt(routine, now)?.toISOString() ?? null,
    }));
    return NextResponse.json({
      routines,
      schedulerEnabled: isRoutineSchedulerEnabled(),
      // Schedules fire in the server's local zone; the browser may be elsewhere.
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  } catch (error) {
    return routineErrorResponse(error);
  }
}

// POST /api/routines  body: RoutineInput
export async function POST(req: Request) {
  try {
    const input = parseRoutineInput(await req.json());
    await assertRoutineTargetExists(input.target);
    return NextResponse.json({ routine: await new RoutineStore().create(input) }, { status: 201 });
  } catch (error) {
    return routineErrorResponse(error);
  }
}
