import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, getCurrentTools } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

// A minimal stdio MCP server with one tool; each start appends its name to MARKER.
const FAKE_SERVER = `
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
appendFileSync(process.env.MARKER, process.env.NAME + "\\n");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } });
  else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unsupported" } });
});
`;

test("a child gets the MCP servers its profile names, with codemode as in the parent", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-mcp-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const marker = join(dir, "started");
  await writeFile(join(dir, "fake-mcp.mjs"), FAKE_SERVER);
  const server = (name, exposure) => ({ command: process.execPath, args: [join(dir, "fake-mcp.mjs")], exposure, env: { MARKER: marker, NAME: name } });
  await writeFile(join(dir, "mcp.json"), JSON.stringify({ mcpServers: {
    browser: server("browser", "codemode"), direct: server("direct", "direct"), off: { ...server("off", "codemode"), enabled: false },
  } }));
  await mkdir(join(dir, "agents"), { recursive: true });
  // Foreground: a background completion would prompt the parent, which shares the faux responses.
  await writeFile(join(dir, "agents", "browse.md"), "---\ndescription: Browse\nrun_in_background: false\ntools: read\nmcp_servers: browser, off\n---\nCHILD\n");
  await writeFile(join(dir, "agents", "all.md"), "---\ndescription: All\nrun_in_background: false\ntools: read\nmcp_servers: \"*\"\n---\nCHILD\n");
  await writeFile(join(dir, "agents", "scripts.md"), "---\ndescription: Scripts\nrun_in_background: false\ntools: read, codemode\n---\nCHILD\n");
  await writeFile(join(dir, "agents", "extended.md"), "---\ndescription: Extended\nrun_in_background: false\ntools: read\nload_extensions: true\nmcp_servers: browser\n---\nCHILD\n");
  await writeFile(join(dir, "agents", "plain.md"), "---\ndescription: Plain\nrun_in_background: false\ntools: read\n---\nCHILD\n");

  const faux = fauxProvider({ models: [{ id: "faux-model" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const services = await createAgentSessionServices({ cwd: dir, agentDir: dir, modelRuntime, settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true } });
  const { session: parentSession } = await createAgentSessionFromServices({
    services, sessionManager: SessionManager.create(dir, join(dir, "sessions")), model: faux.getModel("faux-model"),
  });

  const jiti = createJiti(import.meta.url);
  const { createSubagentController } = await jiti.import("./subagent-runtime.ts");
  const { readSubagentSessionResources } = await jiti.import("./subagents.ts");
  const { AgentSessionWrapper, startRpcSession } = await jiti.import("./rpc-manager.ts");
  const parentId = parentSession.sessionId;
  const children = [];
  const parent = { inner: parentSession, cwd: dir, sessionFile: parentSession.sessionFile, isAlive: () => true, isClosing: () => false, isRunning: () => false };
  const controller = createSubagentController({
    getSession: (id) => (id === parentId ? parent : children.find((child) => child.inner.sessionId === id)),
    registerSession(inner) {
      const wrapper = new AgentSessionWrapper(inner, { chatOnly: false });
      wrapper.start();
      wrapper.beginExtensionBinding();
      children.push(wrapper);
    },
    reopenSession: async () => { throw new Error("unused"); },
    resolveSessionPath: async () => children.at(-1)?.sessionFile ?? null,
    invalidateSessionList() {},
    isSubagentsEnabled: () => true,
  });
  const originalCreate = ModelRuntime.create;
  t.after(async () => {
    for (const child of children) if (child.isAlive()) await child.shutdown();
    parentSession.dispose();
    ModelRuntime.create = originalCreate;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const waitFor = async (condition) => {
    for (const deadline = Date.now() + 5000; !condition() && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 25));
  };
  const hasTool = (child, name) => child.inner.getAllTools().some((tool) => tool.name === name);
  const started = () => (existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").sort() : []);
  const spawn = async (profile, expectTool) => {
    let declared;
    faux.setResponses([(context) => { declared = getCurrentTools(context.messages).map((tool) => tool.name); return fauxAssistantMessage([fauxText("done")]); }]);
    const execution = await controller.extensionRuntime.start({
      parentContext: { sessionManager: parentSession.sessionManager }, parentToolCallId: `start-${profile}`, profile, task: "work", description: "work",
    });
    const done = await execution.completion;
    assert.equal(done.status, "completed", `${profile}: ${done.error}`);
    const child = children.at(-1);
    // MCP tools register when their server connects, which may be after the first request.
    if (expectTool) await waitFor(() => hasTool(child, expectTool));
    return { child, declared, registered: child.inner.getAllTools().map((tool) => tool.name) };
  };

  // Named servers only: `off` stays off, `direct` is not connected. codemode comes from the exposure.
  const browse = await spawn("browse", "mcp__browser__echo");
  assert.ok(browse.declared.includes("codemode"), browse.declared.join());
  assert.ok(browse.declared.includes("read"));
  assert.ok(!browse.declared.includes("bash"));
  assert.ok(!browse.declared.includes("tool_search"), "no deferred server");
  assert.deepEqual(started(), ["browser"]);
  assert.ok(browse.registered.includes("mcp__browser__echo"), browse.registered.join());
  assert.ok(!browse.registered.some((name) => name.startsWith("mcp__direct__")));
  assert.deepEqual(readSubagentSessionResources(browse.child.inner.sessionManager.getEntries()).mcpServers, ["browser", "off"]);

  // `*`: every enabled server; a direct one is declared to the model.
  const all = await spawn("all");
  assert.ok(all.declared.includes("mcp__direct__echo"), all.declared.join());
  assert.ok(all.declared.includes("codemode"));

  // codemode without MCP: the tool, and no server.
  const before = started().length;
  const scripts = await spawn("scripts");
  assert.ok(scripts.declared.includes("codemode"));
  assert.ok(!scripts.registered.some((name) => name.startsWith("mcp__")));
  assert.equal(started().length, before);
  // Kept out of `tools`, which older readers validate strictly; read back merged.
  const snapshot = scripts.child.inner.sessionManager.getEntries().findLast((entry) => entry.customType === "pi-web:subagent").data.resourceSnapshot;
  assert.deepEqual([snapshot.tools, snapshot.builtinTools], [["read"], ["codemode"]]);
  assert.deepEqual(readSubagentSessionResources(scripts.child.inner.sessionManager.getEntries()).tools, ["read", "codemode"]);

  // With extensions loaded, pi's built-ins are no `ext:*` grant: only the exposure switches codemode on.
  const extended = await spawn("extended", "mcp__browser__echo");
  assert.ok(extended.declared.includes("codemode"), extended.declared.join());
  assert.ok(!extended.declared.includes("tool_search"), extended.declared.join());

  // Nothing named: no built-in extensions at all.
  const plain = await spawn("plain");
  assert.deepEqual(plain.declared, ["read"]);

  // Reopened from its snapshot, the child loads the same servers.
  const file = browse.child.sessionFile;
  const id = browse.child.inner.sessionId;
  await browse.child.shutdown();
  ModelRuntime.create = async (...args) => {
    const runtime = await originalCreate.apply(ModelRuntime, args);
    runtime.registerNativeProvider(faux.provider);
    return runtime;
  };
  const reopened = (await startRpcSession(id, file)).session;
  children.push(reopened);
  await reopened.waitUntilReady();
  let declared;
  faux.setResponses([(context) => { declared = getCurrentTools(context.messages).map((tool) => tool.name); return fauxAssistantMessage([fauxText("again")]); }]);
  await reopened.inner.prompt("again");
  assert.ok(declared.includes("codemode"), declared.join());
  await waitFor(() => hasTool(reopened, "mcp__browser__echo"));
  assert.ok(hasTool(reopened, "mcp__browser__echo"));
  assert.ok(!reopened.inner.getAllTools().some((tool) => tool.name.startsWith("mcp__direct__")));
});

test("a child honors -builtin:<name> in extensions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-mcp-off-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "settings.json"), JSON.stringify({ extensions: ["-builtin:mcp"] }));
  const { subagentBuiltinExtensionOptions } = await createJiti(import.meta.url).import("./subagent-builtin-extensions.ts");
  const settings = SettingsManager.create(dir, dir, { projectTrusted: false });
  const options = (resources) => subagentBuiltinExtensionOptions({ loadExtensions: false, ...resources }, dir, dir, settings);
  assert.deepEqual((await options({ tools: ["read"], mcpServers: ["browser"] })).additionalExtensionPaths, ["builtin:codemode", "builtin:tool-search"]);
  assert.deepEqual(await options({ tools: ["read"] }), { extensionFactories: [], additionalExtensionPaths: [] });
});
