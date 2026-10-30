import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const models = await jiti.import("./models/route.ts");
const agent = await jiti.import("./agent/[id]/route.ts");
const newAgent = await jiti.import("./agent/new/route.ts");

test("missing-cwd responses survive independently bundled routes", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-missing-cwd-"));
  await rm(cwd, { recursive: true });
  const previous = globalThis.__piSessions;
  // Plain fields deliberately avoid any shared error constructor.
  globalThis.__piSessions = new Map([["missing-cwd", {
    isAlive: () => true,
    isClosing: () => false,
    inner: { sessionManager: { getEntries: () => [] } },
    send: async () => { throw Object.assign(new Error("Gone"), { reason: "cwd-missing", cwd }); },
  }]]);
  t.after(() => { globalThis.__piSessions = previous; });
  const responses = [
    await models.GET(new Request(`http://localhost/api/models?cwd=${encodeURIComponent(cwd)}`)),
    await newAgent.POST(new Request("http://localhost/api/agent/new", { method: "POST", body: JSON.stringify({ cwd, type: "prompt" }) })),
    await agent.POST(new Request("http://localhost/api/agent/missing-cwd", { method: "POST", body: JSON.stringify({ type: "prompt", message: "hello" }) }), { params: Promise.resolve({ id: "missing-cwd" }) }),
  ];
  for (const response of responses) {
    assert.equal(response.ok, false);
    const body = await response.json();
    assert.equal(body.reason, "cwd-missing", JSON.stringify(body));
    assert.equal(body.cwd, cwd);
  }
});
