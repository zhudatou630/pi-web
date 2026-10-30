/**
 * Whether this process runs the routine scheduler (docs/routines.md). On in production
 * builds, so an installed Pi Web schedules with no setup; off under `next dev`, whose
 * half-edited code shares ~/.pi/agent with the installed service. PI_WEB_SCHEDULER=1/0
 * overrides either way. Kept dependency-free: instrumentation reads it before loading the runner.
 */
export function isRoutineSchedulerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.PI_WEB_SCHEDULER === "1") return true;
  if (env.PI_WEB_SCHEDULER === "0") return false;
  return env.NODE_ENV === "production";
}
