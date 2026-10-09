import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import lockfile from "proper-lockfile";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { readMcpConfigFile, loadSafeMcpConfig } = await jiti.import("./mcp-config-read.ts");
const { editMcpConfigFile, editMcpConfigFileSync, patchMcpServer } = await jiti.import("./mcp-config-file.ts");
const { saveMcpServer, updateMcpServer, removeMcpServer } = await jiti.import("./mcp-config.ts");
const { importSdkFile } = await jiti.import("./builtin-extensions.ts");
const validator = await importSdkFile("core/mcp-servers.js");
const sdk = await importSdkFile("extensions/mcp/config.js");

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-mcp-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const add = (servers, name, value = { command: "node" }) =>
  Object.defineProperty(servers, name, { value, enumerable: true, configurable: true, writable: true });

test("MCP reads are bounded, regular-file-only, and never quote parse source", (t) => {
  const root = temp(t), path = join(root, "mcp.json");
  for (const source of ["{'TOP-SECRET': 1}", '{"key": "TOP-SECRET", nope}', "\uFEFF{}", "[]"]) {
    writeFileSync(path, source);
    assert.throws(() => readMcpConfigFile(path), (error) => !error.message.includes("TOP-SECRET"));
  }
  writeFileSync(path, " ".repeat(1024 * 1024 + 1));
  assert.throws(() => readMcpConfigFile(path), /1 MiB/);
  rmSync(path); mkdirSync(path);
  assert.throws(() => readMcpConfigFile(path), /regular file/);
  rmSync(path, { recursive: true });
  if (process.platform !== "win32") {
    assert.equal(spawnSync("mkfifo", [path]).status, 0);
    assert.throws(() => readMcpConfigFile(path), /regular file/);
  }
});

test("project links stay inside the project, global links remain user-controlled", async (t) => {
  const root = temp(t), project = join(root, "project"), outside = join(root, "outside");
  mkdirSync(project); mkdirSync(outside); mkdirSync(join(project, ".pi"));
  const external = join(outside, "mcp.json");
  writeFileSync(external, '{"mcpServers":{"s":{"command":"node"}}}');
  const path = join(project, ".pi", "mcp.json");
  symlinkSync(external, path);
  assert.throws(() => readMcpConfigFile(path, project), /outside/);
  await assert.rejects(editMcpConfigFile(path, (s) => add(s, "new"), project), /outside/);
  assert.equal(readFileSync(external, "utf8"), '{"mcpServers":{"s":{"command":"node"}}}');
  await editMcpConfigFile(path, (s) => add(s, "global"));
  assert.ok(lstatSync(path).isSymbolicLink(), "atomic replacement must preserve the link");
  rmSync(path); symlinkSync(join(outside, "missing.json"), path);
  assert.throws(() => readMcpConfigFile(path, project), /Dangling/);
  await editMcpConfigFile(path, (s) => add(s, "global-dangling"));
  assert.ok(lstatSync(path).isSymbolicLink());
  assert.ok(Object.hasOwn(readMcpConfigFile(join(outside, "missing.json")).document.mcpServers, "global-dangling"));
  if (process.platform !== "win32") assert.equal(statSync(join(outside, "missing.json")).mode & 0o777, 0o600);
  rmSync(join(project, ".pi"), { recursive: true });
  symlinkSync(outside, join(project, ".pi"));
  assert.throws(() => readMcpConfigFile(path, project), /outside/);
});

test("safe loader matches SDK precedence, aliases, conflicts, overrides, and project auth rules", (t) => {
  const root = temp(t), agentDir = join(root, "agent"), cwd = join(root, "project");
  mkdirSync(agentDir); mkdirSync(join(cwd, ".pi"), { recursive: true });
  const global = { autoEnableCodemode: false, mcpServers: {
    base: { command: "node", env: { TOKEN: "${OTHER}" }, exposure: "codemode-deferred" },
    replaced: { command: "node" }, same_name: { command: "node" }, constructor: { command: "node" },
  } };
  const project = { autoEnableCodemode: true, mcpServers: {
    base: { enabled: false }, replaced: { url: "https://example.test/mcp" },
    "same-name": { command: "node" }, invalid: null,
    forbidden: { url: "https://example.test/mcp", auth: { provider: "p" } },
  } };
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify(global));
  writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify(project));
  for (const projectTrusted of [false, true]) {
    const options = { agentDir, cwd, projectTrusted };
    const actual = loadSafeMcpConfig(options, validator), expected = sdk.loadMcpConfig(options);
    assert.deepEqual(actual.servers, expected.servers);
    assert.equal(actual.autoEnableCodemode, expected.autoEnableCodemode);
    assert.deepEqual(actual.errors, expected.errors);
  }
  writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`s${i}`, { command: "node" }])) }));
  const loaded = loadSafeMcpConfig({ agentDir, cwd, projectTrusted: true }, validator);
  assert.match(loaded.errors.join(), /200 servers/);
  assert.equal(loaded.servers.length, 4, "bad project files must not hide global servers");
});

test("session loading refuses unsafe OAuth before the SDK's direct sign-in path", async (t) => {
  const agentDir = temp(t);
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
    unsafe: { url: "https://unused.invalid/mcp", oauth: { clientSecret: "${PI_WEB_PASSWORD}" } },
    safe: { command: "node" },
  } }));
  const options = { agentDir, cwd: agentDir, projectTrusted: false };
  assert.equal(loadSafeMcpConfig(options, validator).servers.length, 2, "Settings keeps unsafe entries editable");
  const loaded = loadSafeMcpConfig(options, validator, await importSdkFile("core/resolve-config-value.js"));
  assert.deepEqual(loaded.servers.map((s) => s.name), ["safe"]);
  assert.match(loaded.errors.join(), /PI_WEB_PASSWORD/);
});

test("writes preserve SDK bytes/unknown keys, use atomic replacement, and refuse broken files", async (t) => {
  const root = temp(t);
  for (const indent of [2, 4, "\t"]) {
    const original = JSON.stringify({ unknown: "keep", mcpServers: { s: { command: "node", enabled: false } } }, null, indent) + "\n";
    const safePath = join(root, "safe.json"), sdkPath = join(root, "sdk.json");
    writeFileSync(safePath, original); writeFileSync(sdkPath, original);
    chmodSync(safePath, 0o640);
    const inode = statSync(safePath).ino;
    sdk.updateMcpServerConfig(sdkPath, "s", { enabled: true, exposure: "direct" });
    await editMcpConfigFile(safePath, (s) => patchMcpServer(s, "s", { enabled: true, exposure: "direct" }));
    assert.equal(readFileSync(safePath, "utf8"), readFileSync(sdkPath, "utf8"));
    assert.notEqual(statSync(safePath).ino, inode);
    if (process.platform !== "win32") assert.equal(statSync(safePath).mode & 0o777, 0o640);
  }
  const path = join(root, "broken.json"), source = "{'TOP-SECRET': 123}";
  writeFileSync(path, source);
  await assert.rejects(editMcpConfigFile(path, (s) => add(s, "new")), /invalid JSON/);
  assert.equal(readFileSync(path, "utf8"), source);
  assert.ok(!readdirSync(root).some((name) => name.endsWith(".tmp")));
});

test("public Settings writes and SDK sync edits use own properties, including prototype names", async (t) => {
  const agentDir = temp(t), path = join(agentDir, "mcp.json");
  const prototype = Object.getOwnPropertyDescriptors(Object.prototype);
  for (const name of ["__proto__", "constructor", "toString"]) {
    await assert.rejects(updateMcpServer({ cwd: null, scope: "global", name, enabled: false }, agentDir), /No MCP server/);
    await saveMcpServer({ cwd: null, scope: "global", name, config: { command: "node" } }, agentDir);
    await updateMcpServer({ cwd: null, scope: "global", name, enabled: false }, agentDir);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).mcpServers[name].enabled, false);
    editMcpConfigFileSync(path, (s) => patchMcpServer(s, name, { enabled: true }));
    await removeMcpServer({ cwd: null, scope: "global", name }, agentDir);
  }
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), prototype);
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  await saveMcpServer({ cwd: null, scope: "global", name: "old", config: { command: "node" } }, agentDir);
  await saveMcpServer({ cwd: null, scope: "global", name: "new", previousName: "old", config: { command: "node" } }, agentDir);
  assert.deepEqual(Object.keys(readMcpConfigFile(path).document.mcpServers), ["new"]);
});

test("a link changed while waiting for the lock never writes under the wrong lock", async (t) => {
  const root = temp(t), first = join(root, "first.json"), second = join(root, "second.json"), link = join(root, "mcp.json");
  writeFileSync(first, "{}"); writeFileSync(second, "{}"); symlinkSync(first, link);
  const release = await lockfile.lock(first);
  const pending = editMcpConfigFile(link, (s) => add(s, "wrong-file"));
  const refused = assert.rejects(pending, /path changed/);
  rmSync(link); symlinkSync(second, link);
  await release(); await refused;
  assert.equal(readFileSync(first, "utf8"), "{}");
  assert.equal(readFileSync(second, "utf8"), "{}");
});

test("locks serialize concurrent updates and wait for another holder", async (t) => {
  const root = temp(t), path = join(root, "mcp.json");
  const release = await lockfile.lock(path, { realpath: false });
  const pending = editMcpConfigFile(path, (s) => add(s, "first"));
  setTimeout(() => void release(), 150);
  await pending;
  await Promise.all(Array.from({ length: 12 }, (_, i) => editMcpConfigFile(path, (s) => add(s, `s${i}`))));
  assert.equal(Object.keys(readMcpConfigFile(path).document.mcpServers).length, 13);
  assert.deepEqual(readdirSync(root), ["mcp.json"]);
});
