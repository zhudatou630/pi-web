import { closeAllAgentEventStreams } from "@/lib/agent-event-stream";
import { configureHttpDispatcher } from "@/lib/http-dispatcher";

/**
 * Node-only startup work.
 *
 * Next 16 production handles SIGINT/SIGTERM via `server.close()` and waits forever
 * for every connection to end, so a live SSE stream strands the process after the
 * listener is gone. Close them on the way down so the drain can finish.
 *
 * `globalThis` guards keep a re-registration (dev hot reload, double register) from
 * stacking handlers and warning about an exceeded max listener count.
 */
const SHUTDOWN_HOOK_KEY = Symbol.for("@calmabacus/pi-web/node-shutdown-hook/v1");

export async function registerNodeRuntime(): Promise<void> {
  configureHttpDispatcher();

  const host = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (host[SHUTDOWN_HOOK_KEY]) return;
  host[SHUTDOWN_HOOK_KEY] = true;

  // `once` + a synchronous close: Next's own handlers still run, and a second
  // signal is left to the default behavior so the process can always be killed.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      const closed = closeAllAgentEventStreams();
      if (closed > 0) {
        console.log(`[pi-web] closed ${closed} live agent event stream(s) for ${signal}`);
      }
    });
  }
}
