import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// A minimal stdio MCP server with one tool.
const FAKE_SERVER = `
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } });
  else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unsupported" } });
});
`;

test("sessions load pi's built-in MCP, codemode, and tool search; Chat only does not", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-web-mcp-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(cwd);
  writeFileSync(path.join(root, "fake-mcp.mjs"), FAKE_SERVER);
  writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [path.join(root, "fake-mcp.mjs")] } } }));
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ enableInstallTelemetry: false }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const wrappers = [];
  t.after(() => {
    for (const wrapper of wrappers) wrapper.destroy();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  const rpc = await createJiti(import.meta.url, { moduleCache: false }).import("./rpc-manager.ts");
  const wrapper = (await rpc.startRpcSession(`mcp-${Date.now()}`, "", cwd, { toolNames: ["read"] })).session;
  wrappers.push(wrapper);
  await wrapper.waitUntilReady();
  const deadline = Date.now() + 10_000;
  while (!wrapper.inner.getAllTools().some((tool) => tool.name === "mcp__fake__echo") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(wrapper.inner.getAllTools().some((tool) => tool.name === "mcp__fake__echo"));
  assert.ok(wrapper.inner.getActiveToolNames().includes("codemode"), "MCP activates codemode for its tools");

  const chatOnly = (await rpc.startRpcSession(`mcp-chat-only-${Date.now()}`, "", cwd, { toolNames: [] })).session;
  wrappers.push(chatOnly);
  await chatOnly.waitUntilReady();
  assert.ok(!chatOnly.inner.getAllTools().some((tool) => tool.name === "codemode"));
});
