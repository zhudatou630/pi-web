import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { fauxAssistantMessage, fauxProvider, getCurrentTools } from "@earendil-works/pi-ai";

// A minimal stdio MCP server with one tool.
const FAKE_SERVER = `
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
if (process.env.MARKER) appendFileSync(process.env.MARKER, process.pid + "\\n");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } });
  else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unsupported" } });
});
`;

test("viewed runtimes spawn no MCP servers; the first request includes direct and discovery tools; Chat only loads none", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-web-mcp-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(cwd);
  writeFileSync(path.join(root, "fake-mcp.mjs"), FAKE_SERVER);
  const marker = path.join(root, "started");
  writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: Object.fromEntries(
    ["codemode", "deferred", "direct"].map((exposure) => [exposure, {
      command: process.execPath, args: [path.join(root, "fake-mcp.mjs")], exposure, env: { MARKER: marker },
    }]),
  ) }));
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ enableInstallTelemetry: false }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const wrappers = [];
  t.after(async () => {
    for (const wrapper of wrappers) await wrapper.shutdown();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  const rpc = await createJiti(import.meta.url, { moduleCache: false }).import("./rpc-manager.ts");
  const wrapper = (await rpc.startRpcSession(`mcp-${Date.now()}`, "", cwd, { toolNames: ["read"] })).session;
  wrappers.push(wrapper);
  await wrapper.waitUntilReady();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(existsSync(marker), false, "merely viewing a runtime must not spawn a server");
  assert.ok(!wrapper.inner.getAllTools().some((tool) => tool.name.startsWith("mcp__")));

  const faux = fauxProvider({ provider: "mcp-test", models: [{ id: "test" }] });
  wrapper.inner.modelRuntime.registerNativeProvider(faux.provider);
  await wrapper.inner.setModel(faux.getModel());
  let requests = 0;
  let firstTools;
  faux.setResponses([(context) => {
    requests++;
    firstTools = getCurrentTools(context.messages).map((tool) => tool.name);
    return fauxAssistantMessage("ok");
  }]);
  await wrapper.send({ type: "prompt", message: "hello" });
  await wrapper.inner.waitForIdle();
  assert.equal(requests, 1);
  for (const name of ["mcp__direct__echo", "codemode", "tool_search"]) {
    assert.ok(firstTools.includes(name), `${name} must be declared in the FIRST request`);
  }
  await wrapper.send({ type: "prompt", message: "/mcp" });
  assert.equal(readFileSync(marker, "utf8").trim().split("\n").length, 3, "each server starts only once");

  const chatOnly = (await rpc.startRpcSession(`mcp-chat-only-${Date.now()}`, "", cwd, { toolNames: [] })).session;
  wrappers.push(chatOnly);
  await chatOnly.waitUntilReady();
  assert.ok(!chatOnly.inner.getAllTools().some((tool) => tool.name === "codemode"));
});

for (const trigger of ["user", "custom", "/mcp"]) {
  test(`lazy MCP starts once on ${trigger}, ignores early changes, and resets on shutdown`, async () => {
    const { deferMcpStart } = await createJiti(import.meta.url).import("./builtin-extensions.ts");
    const handlers = new Map();
    const commands = new Map();
    const calls = [];
    let registeredServers = [];
    const pi = {
      on(event, handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        return () => {};
      },
      registerCommand: (name, command) => commands.set(name, command),
      getMcpServers: () => registeredServers,
    };
    const startupCtx = { cwd: "startup" };
    const ctx = { cwd: "current" };
    const fire = async (type, context = ctx) => {
      for (const handler of handlers.get(type) ?? []) await handler({ type, messageType: trigger }, context);
    };
    const complete = () => [];
    await deferMcpStart((deferredPi) => {
      deferredPi.on("session_start", (event, currentCtx) => {
        assert.equal(event.type, "session_start");
        assert.equal(currentCtx, ctx, "initialization uses the trigger's current context");
        calls.push(["start", deferredPi.getMcpServers()]);
      });
      deferredPi.on("before_agent_start", () => { calls.push("before"); return { message: "preserved" }; });
      deferredPi.on("mcp_servers_change", () => { calls.push("change"); });
      deferredPi.on("session_shutdown", () => { calls.push("shutdown"); });
      deferredPi.on("tool_call", () => ({ block: true, reason: "preserved" }));
      deferredPi.registerCommand("mcp", {
        description: "preserved", getArgumentCompletions: complete,
        handler: (args, currentCtx) => { assert.equal(currentCtx, ctx); calls.push(["command", args]); },
      });
    })(pi);
    await fire("session_start", startupCtx);
    registeredServers = ["added-before-first-prompt"];
    await fire("mcp_servers_change");
    assert.deepEqual(calls, []);
    assert.equal(commands.get("mcp").getArgumentCompletions, complete);
    assert.equal(commands.get("mcp").description, "preserved");

    if (trigger === "/mcp") await commands.get("mcp").handler("reconnect fake", ctx);
    else assert.deepEqual(await handlers.get("before_agent_start")[0]({ type: "before_agent_start", messageType: trigger }, ctx), { message: "preserved" });
    assert.deepEqual(calls[0], ["start", registeredServers]);
    await fire("before_agent_start");
    await commands.get("mcp").handler("", ctx);
    assert.equal(calls.filter((call) => Array.isArray(call) && call[0] === "start").length, 1);
    await fire("mcp_servers_change");
    assert.equal(calls.at(-1), "change");
    assert.deepEqual(await handlers.get("tool_call")[0]({ type: "tool_call" }, ctx), { block: true, reason: "preserved" });

    await fire("session_shutdown");
    assert.equal(calls.at(-1), "shutdown");
    await fire("session_start", startupCtx);
    await fire("mcp_servers_change");
    assert.equal(calls.at(-1), "shutdown");
    await fire("before_agent_start");
    assert.equal(calls.filter((call) => Array.isArray(call) && call[0] === "start").length, 2);
  });
}

test("MCP stdio servers get the project command environment, HTTP transports are untouched", async () => {
  const builtin = await createJiti(import.meta.url).import("./builtin-extensions.ts");
  const { createDefaultTransport } = await builtin.importSdkFile("extensions/mcp/runtime.js");
  const host = { PATH: "/usr/bin", PORT: "30141", NODE_ENV: "production", NEXT_RUNTIME: "nodejs", PI_WEB_PASSWORD: "x", KEEP: "1" };
  const stdio = builtin.withProjectEnvironment(
    createDefaultTransport({ name: "s", config: { command: "node", env: { KEEP: "server", PORT: "8080" } } }, "/tmp", undefined),
    host,
  );
  assert.equal(stdio.options.inheritEnv, false);
  assert.deepEqual(stdio.options.env, { PATH: "/usr/bin", KEEP: "server", PORT: "8080" });
  const http = createDefaultTransport({ name: "h", config: { url: "https://example.com/mcp" } }, "/tmp", undefined);
  assert.equal(builtin.withProjectEnvironment(http, host), http);
});
