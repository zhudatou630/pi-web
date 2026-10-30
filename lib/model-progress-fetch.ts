/** HTTP model transport with an inactivity timer renewed by actual body bytes. */
export async function modelProgressFetch(input: string, init: RequestInit, idleMs: number): Promise<Response> {
  const controller = new AbortController();
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new DOMException("Model response made no output progress", "TimeoutError")), idleMs);
  };
  touch();
  try {
    const response = await fetch(input, { ...init, signal });
    if (!response.body) { clearTimeout(timer); return response; }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(target) {
        let abort: (() => void) | undefined;
        try {
          signal.throwIfAborted();
          const cancelled = new Promise<never>((_, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
          });
          const { value, done } = await Promise.race([reader.read(), cancelled]);
          if (done) { clearTimeout(timer); reader.releaseLock(); target.close(); }
          else { if (value.byteLength) touch(); target.enqueue(value); }
        } catch (error) {
          clearTimeout(timer);
          void reader.cancel(error).catch(() => {});
          target.error(error);
        } finally { if (abort) signal.removeEventListener("abort", abort); }
      },
      async cancel(reason) { clearTimeout(timer); controller.abort(reason); await reader.cancel(reason); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) { clearTimeout(timer); throw error; }
}
