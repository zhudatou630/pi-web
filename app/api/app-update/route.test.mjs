import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const versionHelpers = await jiti.import("../../../lib/app-update.ts");
const source = ts.transpileModule(readFileSync(new URL("./route.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function route({ enabled = true, sessions = false, terminals = false } = {}) {
  const deferred = [];
  const messages = [];
  const exports = {};
  const context = vm.createContext({
    exports, console, AbortSignal, URL,
    process: {
      env: { PI_WEB_CAN_UPDATE: enabled ? "1" : "0", NEXT_PUBLIC_APP_VERSION: "1.0.0" },
      connected: true,
      send: (message, callback) => { messages.push(message); callback(null); },
    },
    fetch: async () => Response.json({ version: "1.1.0" }),
    require: (name) => {
      if (name === "next/server") return { NextResponse: Response, after: (fn) => deferred.push(fn) };
      if (name === "@/lib/app-update") return versionHelpers;
      if (name === "@/lib/rpc-manager") return { hasAppUpdateBlockingSessions: () => sessions };
      if (name === "@/lib/terminal-manager") return { hasAppUpdateBlockingTerminals: () => terminals };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  vm.runInContext(source, context);
  return { ...exports, deferred, messages, context };
}

test("version checks are enabled by default and responses cannot be cached by the browser", async () => {
  const response = await route().GET(new Request("http://localhost/api/app-update"));
  const data = await response.json();
  assert.equal(data.currentVersion, "1.0.0");
  assert.equal(data.latestVersion, "1.1.0");
  assert.equal(data.updateAvailable, true);
  assert.equal(data.canUpdate, true);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("restart status returns the installed version without contacting npm", async () => {
  const api = route();
  api.context.fetch = () => assert.fail("restart polling must not depend on npm");
  const response = await api.GET(new Request("http://localhost/api/app-update?status=1"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).currentVersion, "1.0.0");
});

test("unsupported installations, active sessions and terminals cannot trigger updates", async () => {
  for (const options of [{ enabled: false }, { sessions: true }, { terminals: true }]) {
    const api = route(options);
    assert.equal((await api.POST()).status, 409);
    assert.equal(api.deferred.length, 0);
    assert.equal(api.context.__piWebUpdating, undefined);
  }
});

test("accepts only one update and defers shutdown until the response has been sent", async () => {
  const api = route();
  const results = await Promise.all([api.POST(), api.POST()]);
  assert.deepEqual(results.map((response) => response.status).sort(), [202, 409]);
  assert.equal(api.context.__piWebUpdating, true);
  assert.equal(api.messages.length, 0);
  assert.equal(api.deferred.length, 1);
  api.deferred[0]();
  assert.equal(api.messages[0].type, "pi-web:update");
});

test("a disconnected launcher refuses updates", async () => {
  const api = route();
  api.context.process.connected = false;
  assert.equal((await api.POST()).status, 409);
  assert.equal(api.deferred.length, 0);
});
