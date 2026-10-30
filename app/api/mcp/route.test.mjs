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
  else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "Echo it\\nMore", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } }] } });
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
  assert.deepEqual(check.servers[0].tools, [{ name: "echo", description: "Echo it", exposure: "direct", readOnly: true }]);
  assert.equal((await send(CHECK, "POST", { name: "missing" })).status, 400);

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

test("a project override changes only enabled/exposure of a global server (pi 1.0.1+)", async () => {
  const project = join(root, "override-project");
  mkdirSync(project, { recursive: true });
  allowFileRoot(project);
  const projectFile = join(project, ".pi", "mcp.json");
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { shared: { url: "https://x/mcp", headers: { A: "${TOKEN}" } } } }));
  const list = async () => (await GET(new Request(`http://localhost/api/mcp?cwd=${encodeURIComponent(project)}`))).json();

  // "Disable in this project" adds an override entry and trusts the project.
  let response = await send(PATCH, "PATCH", { cwd: project, scope: "project", name: "shared", override: true, enabled: false });
  assert.equal(response.status, 200);
  assert.deepEqual(read(projectFile).mcpServers, { shared: { enabled: false } });
  let body = await list();
  assert.deepEqual(body.errors, []);
  assert.deepEqual(body.servers.map((s) => [s.scope, s.name, s.enabled, s.projectOverride === true]), [["global", "shared", false, true]]);
  assert.deepEqual(body.servers[0].headers, [{ name: "A", kind: "env", detail: "TOKEN" }]);

  // Later changes go to the override; the global entry stays untouched.
  await send(PATCH, "PATCH", { cwd: project, scope: "project", name: "shared", override: true, exposure: "direct" });
  assert.deepEqual(read(projectFile).mcpServers.shared, { enabled: false, exposure: "direct" });
  assert.equal(read(join(agentDir, "mcp.json")).mcpServers.shared.exposure, undefined);

  // Overrides need a global server; resetting removes the override.
  assert.equal((await send(PATCH, "PATCH", { cwd: project, scope: "project", name: "missing", override: true, enabled: false })).status, 400);
  await send(DELETE, "DELETE", { cwd: project, scope: "project", name: "shared" });
  body = await list();
  assert.deepEqual(body.servers.map((s) => [s.enabled, s.projectOverride === true]), [[true, false]]);
});

test("responses carry secret names and kinds, never values; Edit JSON reads the entry as written", async () => {
  const secret = "sk-literal-never-shown";
  writeFileSync(join(agentDir, "mcp.json"), "{}");
  const docs = {
    url: `https://example.com/mcp?api_key=${secret}`,
    headers: { "X-Key": secret, "X-Env": "Bearer ${DOCS_TOKEN}", "X-Cmd": "!gh auth token" },
    oauth: { clientId: "id", clientSecret: secret },
  };
  const local = {
    command: "npx",
    args: ["server", "--api-key", secret, `--token=${secret}`, `--url=https://user:${secret}@example.com/mcp?k=${secret}`],
    env: { KEY: secret, CMD: `!printf '${secret}'` },
  };
  const responses = [
    await send(PUT, "PUT", { scope: "global", name: "docs", config: docs }),
    await send(PUT, "PUT", { scope: "global", name: "local", config: local }),
    await send(PATCH, "PATCH", { scope: "global", name: "local", enabled: false }),
  ];
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes(secret));
  }
  const listed = await (await GET(new Request(`http://localhost/api/mcp?cwd=${encodeURIComponent(cwd)}`))).json();
  const byName = Object.fromEntries(listed.servers.map((server) => [server.name, server]));
  assert.equal(byName.docs.transport, "https://example.com/mcp?•••");
  assert.deepEqual(byName.docs.headers, [
    { name: "X-Key", kind: "literal" },
    { name: "X-Env", kind: "env", detail: "DOCS_TOKEN" },
    { name: "X-Cmd", kind: "command" },
  ]);
  assert.deepEqual([byName.docs.oauth, byName.docs.clientSecret, byName.docs.usesOAuth, byName.docs.signedIn], [["clientId"], { name: "clientSecret", kind: "literal" }, true, false]);
  assert.equal(byName.local.transport, "npx server --api-key ••• --token=••• --url=https://example.com/mcp?•••");
  assert.deepEqual(byName.local.env, [{ name: "KEY", kind: "literal" }, { name: "CMD", kind: "command" }]);

  const raw = await GET(new Request(`http://localhost/api/mcp?cwd=${encodeURIComponent(cwd)}&scope=global&name=docs`));
  assert.deepEqual((await raw.json()).config, docs);
  assert.equal((await GET(new Request(`http://localhost/api/mcp?scope=global&name=missing`))).status, 400);
});

test("a project entry may not carry auth: pi would skip it", async () => {
  const response = await send(PUT, "PUT", { scope: "project", name: "p", config: { url: "https://x/mcp", auth: { provider: "anthropic" } } });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /only allowed in the global/);
});

test("per-tool exposure edits keep rule order; an override starts from the global rules", async () => {
  const project = join(root, "tool-project");
  mkdirSync(project, { recursive: true });
  allowFileRoot(project);
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { gh: { url: "https://x/mcp", toolExposure: { "get_*": "hidden", a: "direct" } } } }));
  await send(PATCH, "PATCH", { scope: "global", name: "gh", toolExposure: { b: "deferred", a: null } });
  assert.deepEqual(read(join(agentDir, "mcp.json")).mcpServers.gh.toolExposure, { "get_*": "hidden", b: "deferred" });

  const projectFile = join(project, ".pi", "mcp.json");
  await send(PATCH, "PATCH", { cwd: project, scope: "project", name: "gh", override: true, toolExposure: { c: "direct" } });
  assert.deepEqual(read(projectFile).mcpServers.gh, { toolExposure: { "get_*": "hidden", b: "deferred", c: "direct" } });
  // Emptied, an override keeps its map: dropping it would bring the global rules back.
  await send(PATCH, "PATCH", { cwd: project, scope: "project", name: "gh", override: true, toolExposure: { "get_*": null, b: null, c: null } });
  assert.deepEqual(read(projectFile).mcpServers.gh, { toolExposure: {} });
  const listed = await (await GET(new Request(`http://localhost/api/mcp?cwd=${encodeURIComponent(project)}`))).json();
  assert.deepEqual(listed.servers[0].toolExposure, {});

  assert.equal((await send(PATCH, "PATCH", { scope: "global", name: "gh", toolExposure: { x: "bogus" } })).status, 400);
  assert.equal((await send(PATCH, "PATCH", { scope: "global", name: "gh", toolExposure: ["x"] })).status, 400);
});

test("the check sends the provider's stored key to auth.provider servers", async (t) => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.method !== "POST") return void res.writeHead(405).end();
      if (req.headers.authorization !== "Bearer provider-key") return void res.writeHead(401).end();
      const msg = JSON.parse(body);
      if (msg.id === undefined) return void res.writeHead(202).end();
      const result = msg.method === "initialize"
        ? { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "h", version: "1" } }
        : { tools: [] };
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); rmSync(join(agentDir, "auth.json"), { force: true }); });
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "provider-key" } }));
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
    prov: { url: `http://127.0.0.1:${server.address().port}/mcp`, auth: { provider: "anthropic" } },
  } }));
  const check = await (await send(CHECK, "POST", { name: "prov" })).json();
  assert.equal(check.servers[0].state, "connected", check.servers[0].error);
});
