import { existsSync } from "node:fs";
import { resolveSessionPath } from "@/lib/session-reader";
import { RoutineError, type RoutineTarget } from "@/lib/routines";

/** The chat a routine continues must exist; otherwise the project directory must. */
export async function assertRoutineTargetExists(target: RoutineTarget): Promise<void> {
  if (target.kind === "same_session" && target.sessionId) {
    if (!await resolveSessionPath(target.sessionId)) throw new RoutineError(`Chat not found: ${target.sessionId}`, 400);
    return;
  }
  if (!existsSync(target.cwd)) throw new RoutineError(`Directory does not exist: ${target.cwd}`, 400);
}
