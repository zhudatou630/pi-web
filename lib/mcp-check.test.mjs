import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { checkMcpServers } = await createJiti(import.meta.url).import("./mcp-config.ts");

const server = `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
if (process.env.MARKER) writeFileSync(process.env.MARKER, String(process.pid));
const send = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
if (process.env.HANG) { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
createInterface({input:process.stdin}).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (process.env.HANG) {
    if (process.env.DELAY && msg.method === 'initialize') setTimeout(() => send(msg.id, {protocolVersion: msg.params.protocolVersion, capabilities:{tools:{}}, serverInfo:{name:'test',version:'1'}}), Number(process.env.DELAY));
    return;
  }
  if (msg.method === 'initialize') send(msg.id, {protocolVersion: msg.params.protocolVersion, capabilities:{tools:{}}, serverInfo:{name:'test',version:'1'}});
  else if (msg.method === 'tools/list') send(msg.id, {tools:[{name:[process.env.PI_WEB_PASSWORD ?? 'no-password', process.env.X ?? '', process.env.PORT ?? 'no-port'].join('_'),inputSchema:{type:'object'}}]});
});
`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-mcp-check-"));
  const agentDir = join(root, "agent"), cwd = join(root, "project"), script = join(root, "server.mjs");
  mkdirSync(agentDir); mkdirSync(cwd); writeFileSync(script, server);
  t.after(() => {
    const marker = join(root, "pid");
    if (existsSync(marker)) {
      try { process.kill(Number(readFileSync(marker, "utf8")), "SIGKILL"); } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  });
  const config = (mcpServers) => writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers }));
  return { root, cwd, agentDir, script, config };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const running = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("Settings check uses the session's safe transport and closes the child", async (t) => {
  const f = fixture(t), marker = join(f.root, "pid");
  const previous = process.env.PI_WEB_PASSWORD;
  process.env.PI_WEB_PASSWORD = "task-c-never-pass";
  t.after(() => {
    if (previous === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = previous;
  });
  f.config({
    safe: { command: process.execPath, args: [f.script], env: { MARKER: marker, X: "!printf '!safe,}${MCP_COMMAND_LITERAL}'; echo ignored >&2" } },
    leak: { command: process.execPath, args: [f.script], env: { X: "${PI_WEB_PASSWORD}" } },
    disabled: { command: process.execPath, args: [f.script], enabled: false },
    header: { url: "https://unused.invalid/mcp", headers: { Authorization: "Bearer ${PI_WEB_PASSWORD}" } },
    oauth: { url: "https://unused.invalid/mcp", oauth: { clientSecret: "${PI_WEB_PASSWORD}" } },
  });
  const result = await checkMcpServers(f.cwd, f.agentDir);
  assert.equal(result.servers[0].state, "connected");
  assert.deepEqual(result.servers[0].tools, ["no-password_!safe,}${MCP_COMMAND_LITERAL}_no-port"]);
  for (const i of [1, 3, 4]) {
    assert.equal(result.servers[i].state, "failed");
    assert.match(result.servers[i].error, /PI_WEB_PASSWORD/);
  }
  assert.equal(result.servers[2].state, "disabled");
  assert.ok(!JSON.stringify(result).includes("task-c-never-pass"));
  const pid = Number(readFileSync(marker, "utf8"));
  for (let i = 0; i < 20 && running(pid); i++) await pause(50);
  assert.equal(running(pid), false);
  assert.equal(process.env.PI_WEB_PASSWORD, "task-c-never-pass");
});

test("untrusted project commands are never run, malformed JSON never echoes a secret", async (t) => {
  const f = fixture(t), marker = join(f.root, "never-created");
  mkdirSync(join(f.cwd, ".pi"));
  writeFileSync(join(f.cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { s: { command: process.execPath, args: [f.script], env: { X: `!touch '${marker}'` } } } }));
  writeFileSync(join(f.agentDir, "mcp.json"), "{'PARSE-SECRET':1}");
  const result = await checkMcpServers(f.cwd, f.agentDir);
  assert.deepEqual(result.servers, []);
  assert.match(result.note, /not trusted/);
  assert.match(result.errors.join(), /invalid JSON/);
  assert.ok(!JSON.stringify(result).includes("PARSE-SECRET"));
  assert.equal(existsSync(marker), false);
});

test("hanging SIGTERM-ignoring MCP servers have an overall deadline and bounded close", { timeout: 28_000 }, async (t) => {
  const f = fixture(t), marker = join(f.root, "pid");
  const { importSdkFile } = await createJiti(import.meta.url).import("./builtin-extensions.ts");
  const { createDefaultTransport } = await importSdkFile("extensions/mcp/runtime.js");
  const Stdio = createDefaultTransport({ name: "probe", config: { command: "node" } }, f.cwd).constructor;
  const close = Stdio.prototype.close;
  // Real process cleanup still runs, but its returned promise never settles.
  Stdio.prototype.close = function () { void close.call(this); return new Promise(() => {}); };
  t.after(() => { Stdio.prototype.close = close; });
  f.config({ hang: { command: process.execPath, args: [f.script], timeout: 600, env: { MARKER: marker, HANG: "1", DELAY: "12000" } } });
  const start = Date.now();
  await assert.rejects(checkMcpServers(f.cwd, f.agentDir), /20 seconds/);
  assert.ok(Date.now() - start >= 21_500, "the never-settling close must hit its separate 2 second bound");
  assert.ok(Date.now() - start < 24_000, "check and cleanup must finish within 20 + 2 seconds plus margin");
  const pid = Number(readFileSync(marker, "utf8"));
  for (let i = 0; i < 20 && running(pid); i++) await pause(50);
  assert.equal(running(pid), false, "captured transport must kill the server, not just stop waiting");
});

test("many synchronous SDK !commands cannot bypass the overall check deadline", { timeout: 28_000 }, async (t) => {
  const f = fixture(t);
  f.config({ commands: { command: process.execPath, args: [f.script], env: { X: "!sleep 9; echo a", Y: "!sleep 9; echo b", Z: "!sleep 9; echo c" } } });
  const start = Date.now();
  await assert.rejects(checkMcpServers(f.cwd, f.agentDir), /20 seconds/);
  assert.ok(Date.now() - start < 24_000);
});
