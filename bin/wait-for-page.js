"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setTimeout: delay } = require("node:timers/promises");

// "Ready" precedes lazy route loading; warm the full navigation before the SW's 8s timeout applies.
async function waitForPage(url, timeoutMs = 30_000) {
  let probe;
  try { probe = new URL(url); } catch { return false; }
  if (probe.port === "0") return false; // Next's actual ephemeral port is not known here.
  if (probe.hostname === "0.0.0.0") probe.hostname = "127.0.0.1";
  if (probe.hostname === "[::]") probe.hostname = "[::1]";
  const signal = AbortSignal.timeout(timeoutMs);
  while (!signal.aborted) {
    try {
      const response = await fetch(probe, { signal, redirect: "follow" });
      await response.arrayBuffer();
      return true;
    } catch {
      // The listener may not be accepting yet, or a cold connection may reset.
      await delay(250, undefined, { signal }).catch(() => {});
    }
  }
  return false;
}

module.exports = { waitForPage };
