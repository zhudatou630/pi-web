import { NextResponse } from "next/server";
import { parseRoutineInput, RoutineStore } from "@/lib/routines";
import { invalidateSessionListCache, listAllSessions } from "@/lib/session-reader";
import { updateSidebarState } from "@/lib/sidebar-state";
import { routineErrorResponse } from "../errors";
import { assertRoutineTargetExists } from "../target";

// PATCH /api/routines/[id]  body: full RoutineInput (enabled=false pauses)
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const input = parseRoutineInput(await req.json());
    const store = new RoutineStore();
    // The project cannot change, so only a newly picked chat is checked: a routine whose project
    // or chat has since gone must stay pausable and editable.
    const stored = store.list().find((routine) => routine.id === id)?.target;
    const pickedChat = input.target.kind === "same_session" ? input.target.sessionId : undefined;
    if (pickedChat && !(stored?.kind === "same_session" && stored.sessionId === pickedChat)) await assertRoutineTargetExists(input.target);
    return NextResponse.json({ routine: await store.update(id, input) });
  } catch (error) {
    return routineErrorResponse(error);
  }
}

// DELETE /api/routines/[id] — the chats its runs started are archived, never deleted (as Claude
// does): they were reached only from the routine, so the sidebar's archive is where they stay findable.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await new RoutineStore().remove(id);
    const runChats = (await listAllSessions()).filter((session) => session.routineId === id && session.routineRunOnly);
    if (runChats.length > 0) {
      await updateSidebarState(runChats.map((session) => session.id), { archived: true });
      invalidateSessionListCache();
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return routineErrorResponse(error);
  }
}
