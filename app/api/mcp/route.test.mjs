import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "pi-web-mcp-route-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const FAKE_SERVER = join(root, "fake-mcp.mjs");
writeFileSync(FAKE_SERVER, `
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } });
  else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unsupported" } });
});
`);

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { allowFileRoot } = await jiti.import("../../../lib/file-access.ts");
const { GET, PUT, PATCH, DELETE } = await jiti.import("./route.ts");
const { POST: CHECK } = await jiti.import("./check/route.ts");
allowFileRoot(cwd);

after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
});

const send = (handler, method, body) => handler(new Request("http://localhost/api/mcp", {
  method,
  headers: { "Content-Type": "application/json", Host: "localhost" },
  body: JSON.stringify({ cwd, ...body }),
}));
const read = (path) => JSON.parse(readFileSync(path, "utf8"));

test("servers are added, switched, checked, and removed in the scope's mcp.json", async () => {
  const config = { command: process.execPath, args: [FAKE_SERVER] };
  let response = await send(PUT, "PUT", { scope: "global", name: "fake", config });
  assert.equal(response.status, 200);
  assert.deepEqual(read(join(agentDir, "mcp.json")).mcpServers.fake, config);

  response = await send(PATCH, "PATCH", { scope: "global", name: "fake", exposure: "direct" });
  const body = await response.json();
  assert.equal(body.servers[0].exposure, "direct");

  const check = await (await send(CHECK, "POST", {})).json();
  assert.equal(check.servers[0].state, "connected");
  assert.deepEqual(check.servers[0].tools, ["echo"]);

  // A project entry with the same name replaces the global one; writing it trusts the project.
  await send(PUT, "PUT", { scope: "project", name: "fake", config: { url: "https://example.com/mcp" } });
  const listed = await (await GET(new Request(`http://localhost/api/mcp?cwd=${encodeURIComponent(cwd)}`))).json();
  assert.deepEqual(listed.servers.map((s) => [s.scope, s.overridden === true]), [["global", true], ["project", false]]);
  assert.equal(listed.project.trusted, true);

  assert.equal((await send(PUT, "PUT", { scope: "global", name: "bad name", config })).status, 400);
  await send(DELETE, "DELETE", { scope: "global", name: "fake" });
  assert.deepEqual(read(join(agentDir, "mcp.json")).mcpServers, {});
});

test("built-in extensions switch globally", async () => {
  const body = await (await send(PATCH, "PATCH", { builtin: "mcp", enabled: false })).json();
  assert.deepEqual(read(join(agentDir, "settings.json")).extensions, ["-builtin:mcp"]);
  assert.deepEqual(body.builtins.find((b) => b.name === "mcp"), { name: "mcp", enabled: false, globalEnabled: false });
});

test("invalid entries are reported, not listed; an untrusted project's mcp.json is not read", async () => {
  const untrusted = join(root, "untrusted");
  mkdirSync(join(untrusted, ".pi"), { recursive: true });
  writeFileSync(join(untrusted, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { local: { command: "evil" } } }));
  allowFileRoot(untrusted);
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { old: { url: "https://x/sse", type: "sse" }, ok: { url: "https://x/mcp" } } }));

  const body = await (await GET(new Request(`http://localhost/api/mcp?cwd=${encodeURIComponent(untrusted)}`))).json();
  assert.deepEqual(body.servers.map((s) => s.name), ["ok"]);
  assert.equal(body.errors.length, 1);
  assert.match(body.errors[0], /old/);
  assert.deepEqual({ trusted: body.project.trusted, ignored: body.project.ignored }, { trusted: false, ignored: true });
  assert.equal((await send(PUT, "PUT", { cwd: untrusted, scope: "project", name: "x", config: { command: "y" } })).status, 403);
});
