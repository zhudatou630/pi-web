import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { safeMcpTransportFactory } = await jiti.import("./mcp-transport.ts");
const { importSdkFile, loadSafeMcpTransport } = await jiti.import("./builtin-extensions.ts");
const parsers = await importSdkFile("core/resolve-config-value.js");

test("password references are refused BEFORE SDK resolution, across every resolved field", () => {
  let calls = 0;
  const factory = safeMcpTransportFactory(() => { calls++; return {}; }, parsers, (transport) => transport);
  for (const value of ["${PI_WEB_PASSWORD}", "$PI_WEB_PASSWORD", "Bearer ${pi_web_password}", "!printenv PI_WEB_PASSWORD"]) {
    for (const config of [
      { command: "node", env: { X: value } },
      { url: "https://example.test/mcp", headers: { Authorization: value } },
      { url: "https://example.test/mcp", oauth: { clientSecret: value } },
      // SDK picks HTTP on url presence, even beside type: stdio.
      { type: "stdio", command: "node", url: "https://example.test/mcp", headers: { X: value } },
    ]) assert.throws(() => factory({ name: "s", config }, "/tmp"), /PI_WEB_PASSWORD/);
  }
  assert.equal(calls, 0);
  for (const value of ["$${PI_WEB_PASSWORD}", "$$PI_WEB_PASSWORD", "$!PI_WEB_PASSWORD", "ordinary literal"]) {
    factory({ name: "s", config: { command: "node", env: { X: value } } }, "/tmp");
  }
  assert.equal(calls, 4);
});

test("the production factory refuses interpolation and leaves process.env untouched", async (t) => {
  const previous = process.env.PI_WEB_PASSWORD;
  const sentinel = "task-c-secret";
  process.env.PI_WEB_PASSWORD = sentinel;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = previous;
  });
  const factory = await loadSafeMcpTransport();
  assert.throws(() => factory({ name: "s", config: { command: "node", env: { X: "${PI_WEB_PASSWORD}" } } }, "/tmp"), /PI_WEB_PASSWORD/);
  const transport = factory({ name: "s", config: { command: "node", env: { X: "safe", PI_WEB_PASSWORD: "explicit-not-host" } } }, "/tmp");
  assert.equal(transport.options.inheritEnv, false);
  assert.equal(transport.options.env.X, "safe");
  assert.equal(transport.options.env.PI_WEB_PASSWORD, "explicit-not-host");
  assert.ok(!Object.values(transport.options.env).includes(sentinel));
  assert.equal(process.env.PI_WEB_PASSWORD, sentinel);
});
