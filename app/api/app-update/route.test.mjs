import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const offline = await jiti.import("../../../lib/pi-offline.ts");
const versionHelpers = await jiti.import("../../../lib/app-update.ts");
const source = ts.transpileModule(readFileSync(new URL("./route.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function route({ enabled = true, sessions = false, terminals = false, blocked = "" } = {}) {
  const deferred = [];
  const messages = [];
  const exports = {};
  const context = vm.createContext({
    exports, console, AbortSignal, URL,
    process: {
      env: { PI_WEB_CAN_UPDATE: enabled ? "1" : "0", NEXT_PUBLIC_APP_VERSION: "1.0.0", ...(blocked ? { PI_WEB_UPDATE_BLOCKED: blocked } : {}) },
      connected: true,
      send: (message, callback) => { messages.push(message); callback(null); },
    },
    fetch: async () => Response.json({ version: "1.1.0" }),
    require: (name) => {
      if (name === "next/server") return { NextResponse: Response, after: (fn) => deferred.push(fn) };
      if (name === "@/lib/pi-offline") return offline;
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

test("any defined PI_OFFLINE skips even a forced lookup", async (t) => {
  const original = process.env.PI_OFFLINE;
  t.after(() => { if (original === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = original; });
  const api = route();
  api.context.fetch = () => assert.fail("offline must not contact npm");
  for (const value of ["", "0", "false", "1"]) {
    process.env.PI_OFFLINE = value;
    const response = await api.GET(new Request("http://localhost/api/app-update?force=1"));
    assert.equal((await response.json()).releaseUrl, "");
    assert.equal((await api.POST()).status, 409);
  }
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

test("read-only installs expose the manual update command", async () => {
  const response = await route({ enabled: false, blocked: "readonly" }).GET(new Request("http://localhost/api/app-update"));
  const data = await response.json();
  assert.equal(data.canUpdate, false);
  assert.equal(data.manualCommand, "sudo npm install -g @calmabacus/pi-web@latest");
});

test("a disconnected launcher refuses updates", async () => {
  const api = route();
  api.context.process.connected = false;
  assert.equal((await api.POST()).status, 409);
  assert.equal(api.deferred.length, 0);
});

test("force bypasses the cache and reports failures instead of stale data", async () => {
  const api = route();
  const get = (query = "") => api.GET(new Request(`http://localhost/api/app-update${query}`));
  await get();
  api.context.fetch = async () => Response.json({ version: "1.2.0" });
  assert.equal((await (await get()).json()).latestVersion, "1.1.0");
  assert.equal((await (await get("?force=1")).json()).latestVersion, "1.2.0");
  assert.equal((await (await get()).json()).latestVersion, "1.2.0");
  api.context.fetch = async () => new Response("", { status: 503 });
  assert.equal((await get("?force=1")).status, 502);
});
