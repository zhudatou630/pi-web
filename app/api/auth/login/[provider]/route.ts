import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { createModelsConfigServices, resolveOptionalCwd } from "@/lib/model-config-services";
import { invalidateModelsCache } from "@/lib/models-cache";

export const dynamic = "force-dynamic";

// In-memory registry: loginToken -> resolve/reject for the manualCodeInput promise
declare global {
  var __piLoginCallbacks: Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }> | undefined;
}

function getCallbackRegistry() {
  if (!globalThis.__piLoginCallbacks) globalThis.__piLoginCallbacks = new Map();
  return globalThis.__piLoginCallbacks;
}

// POST /api/auth/login/[provider] — frontend sends redirect URL or auth code
export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const { token, code } = (await req.json()) as { token?: string; code?: string };

  if (!token || !code) {
    return Response.json({ error: "token and code required" }, { status: 400 });
  }

  const registry = getCallbackRegistry();
  const callbacks = registry.get(token);
  if (!callbacks) {
    return Response.json({ error: "No pending login for token" }, { status: 404 });
  }
  // Verify token belongs to this provider (token format: "<provider>-<ts>-<random>")
  if (!token.startsWith(`${provider}-`)) {
    return Response.json({ error: "Token does not match provider" }, { status: 400 });
  }

  callbacks.resolve(code);
  registry.delete(token);
  return Response.json({ ok: true, provider });
}

// GET /api/auth/login/[provider] — SSE stream for OAuth flow
export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;

  const encoder = new TextEncoder();
  let closed = false;
  const send = (controller: ReadableStreamDefaultController, data: unknown) => {
    if (closed) return;
    try {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
    } catch {
      closed = true;
    }
  };
  const close = (controller: ReadableStreamDefaultController) => {
    if (closed) return;
    closed = true;
    try { controller.close(); } catch { /* The reader may already have cancelled. */ }
  };

  // AbortController propagates client disconnect into ModelRuntime.login().
  const abort = new AbortController();
  const disconnect = () => abort.abort();
  req.signal.addEventListener("abort", disconnect);
  if (req.signal.aborted) abort.abort();

  const stream = new ReadableStream({
    async start(controller) {
      const registry = getCallbackRegistry();
      const activeTokens = new Set<string>();
      let pendingManualRequest: { token: string; promise: Promise<string> } | undefined;

      const createClientInputRequest = () => {
        if (closed || abort.signal.aborted) throw new Error("Login cancelled");
        // Unpredictable: this token authorizes a pending login, so a guessable one
        // would let an attacker who knows the provider and timing window complete it.
        const token = `${provider}-${randomUUID()}`;
        activeTokens.add(token);

        const promise = new Promise<string>((resolve, reject) => {
          registry.set(token, {
            resolve: (value) => {
              activeTokens.delete(token);
              registry.delete(token);
              resolve(value);
            },
            reject: (error) => {
              activeTokens.delete(token);
              registry.delete(token);
              reject(error);
            },
          });
        });

        return { token, promise };
      };

      const getManualInputRequest = () => {
        if (!pendingManualRequest) {
          pendingManualRequest = createClientInputRequest();
          pendingManualRequest.promise
            .finally(() => {
              pendingManualRequest = undefined;
            })
            .catch(() => {});
        }
        return pendingManualRequest;
      };

      // Cleanup: remove pending token and abort any waiting promise
      const cleanup = () => {
        for (const token of activeTokens) {
          registry.get(token)?.reject(new Error("Login cancelled"));
          registry.delete(token);
        }
        activeTokens.clear();
      };

      // Also cancel on client disconnect
      abort.signal.addEventListener("abort", cleanup);

      try {
        const resolved = await resolveOptionalCwd(new URL(req.url).searchParams.get("cwd"));
        if ("error" in resolved) throw new Error(resolved.error);
        const { modelRuntime, settingsManager } = await createModelsConfigServices(resolved.cwd);
        if (!modelRuntime.getProvider(provider)?.auth.oauth) throw new Error(`Unknown provider: ${provider}`);
        const loadError = settingsManager.drainErrors()[0];
        if (loadError) throw loadError.error;
        // Persist before login: an unwritable settings file must not produce a throwaway host ID.
        const deviceId = settingsManager.getOrCreateDeviceId();
        await settingsManager.flush();
        const writeError = settingsManager.drainErrors()[0];
        if (writeError) throw writeError.error;
        if (abort.signal.aborted) throw new Error("Login cancelled");
        await modelRuntime.login(provider, "oauth", {
          prompt: async (prompt: AuthPrompt) => {
            const request = prompt.type === "manual_code"
              ? getManualInputRequest()
              : createClientInputRequest();
            if (prompt.type === "select") {
              send(controller, {
                type: "select_request",
                message: prompt.message,
                options: prompt.options,
                token: request.token,
              });
            } else {
              send(controller, {
                type: "prompt_request",
                message: prompt.message,
                placeholder: prompt.placeholder ?? null,
                token: request.token,
              });
            }
            return request.promise;
          },
          notify: (event: AuthEvent) => {
            if (closed || abort.signal.aborted) return;
            if (event.type === "auth_url") {
              const request = getManualInputRequest();
              send(controller, {
                type: "auth",
                url: event.url,
                instructions: event.instructions ?? null,
                token: request.token,
              });
            } else if (event.type === "device_code") {
              send(controller, {
                type: "device_code",
                userCode: event.userCode,
                verificationUri: event.verificationUri,
                intervalSeconds: event.intervalSeconds ?? null,
                expiresInSeconds: event.expiresInSeconds ?? null,
              });
            } else {
              send(controller, { type: "progress", message: event.message });
            }
          },
          signal: abort.signal,
        }, { getDeviceId: () => deviceId });

        invalidateModelsCache();
        send(controller, { type: "success" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== "Login cancelled") {
          send(controller, { type: "error", message: msg });
        } else {
          send(controller, { type: "cancelled" });
        }
      } finally {
        cleanup();
        abort.signal.removeEventListener("abort", cleanup);
        req.signal.removeEventListener("abort", disconnect);
        close(controller);
      }
    },
    cancel() {
      closed = true;
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
