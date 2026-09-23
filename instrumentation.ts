export async function register(): Promise<void> {
  // Positive runtime branch: Next builds this file for both the Node and the Edge
  // entry, and the Edge compilation statically rejects Node APIs. A `!==` guard
  // would only fold away the branch body, not the bundled module graph.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNodeRuntime } = await import("./instrumentation-node");
    await registerNodeRuntime();
  }
}
