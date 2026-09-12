import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./[id]/route.ts");

test("queued subagent sessions reject direct commands", async (t) => {
  const previousRuns = globalThis.__piSubagentRuns;
  const id = "queued-subagent-command";
  globalThis.__piSubagentRuns = new Map([[id, { run: { status: "queued" } }]]);
  t.after(() => { globalThis.__piSubagentRuns = previousRuns; });

  const response = await POST(new Request(`http://localhost/api/agent/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "prompt", message: "bypass queue" }),
  }), { params: Promise.resolve({ id }) });

  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "Subagent is queued");
});