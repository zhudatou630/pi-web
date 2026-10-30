/** Data, not EventSource.readyState, proves a stream is still alive. */
export function createSilenceWatchdog(onSilent: () => void, timeoutMs = 75_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { clearTimeout(timer); };
  return {
    touch() {
      stop();
      timer = setTimeout(onSilent, timeoutMs);
      // Server-side tests must not be kept alive by a browser timer.
      timer.unref?.();
    },
    stop,
  };
}
