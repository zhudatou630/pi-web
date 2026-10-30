import { closeAllAgentEventStreams } from "@/lib/agent-event-stream";
import { configureHttpDispatcher, readHttpIdleTimeoutMs } from "@/lib/http-dispatcher";
import { startPreviewProxy, stopPreviewProxy } from "@/lib/preview-proxy";
import { isRoutineSchedulerEnabled } from "@/lib/routine-scheduler-flag";

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
  // The pi CLI applies settings' `httpIdleTimeoutMs` to the same undici timeouts;
  // without it the built-in five minutes aborts a provider stream the CLI keeps.
  configureHttpDispatcher(readHttpIdleTimeoutMs());

  // Next evaluates a route's code, and with it the pi SDK, on the route's first
  // request (seconds on Windows, #964). Start that import now without awaiting it
  // so register() stays fast; a failure is left for the routes to report.
  import("@earendil-works/pi-coding-agent").catch(() => {});

  const host = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (host[SHUTDOWN_HOOK_KEY]) return;
  host[SHUTDOWN_HOOK_KEY] = true;
  startPreviewProxy();
  if (isRoutineSchedulerEnabled()) {
    import("@/lib/routine-runner")
      .then(({ startRoutineScheduler }) => startRoutineScheduler())
      .catch((error) => console.error("[pi-web] routine scheduler failed to start:", error));
  }

  // `once` + a synchronous close: Next's own handlers still run, and a second
  // signal is left to the default behavior so the process can always be killed.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      stopPreviewProxy();
      const closed = closeAllAgentEventStreams();
      if (closed > 0) {
        console.log(`[pi-web] closed ${closed} live agent event stream(s) for ${signal}`);
      }
    });
  }
}
