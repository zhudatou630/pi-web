import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices, createCodemodeExtension, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { getModelToolEntries } = await jiti.import("./tool-declarations.ts");

function inner() {
  return {
    sessionId: "client-runtime-test", isStreaming: false, isCompacting: false, isBashRunning: false,
    agent: { state: { systemPrompt: "" } }, systemPrompt: "built prompt", extensionRunner: {},
    sessionManager: { getCwd: () => "/tmp", getEntries: () => [] }, getContextUsage: () => null,
    getSteeringMessages: () => [], getFollowUpMessages: () => [], dispose() {},
  };
}

test("get_state falls back before the first run but prefers a nonempty transcript prompt", async (t) => {
  const session = inner();
  const wrapper = new AgentSessionWrapper(session);
  t.after(() => wrapper.destroy());
  assert.equal((await wrapper.send({ type: "get_state" })).systemPrompt, "built prompt");
  session.agent.state.systemPrompt = "extension-modified transcript prompt";
  assert.equal((await wrapper.send({ type: "get_state" })).systemPrompt, "extension-modified transcript prompt");
});

test("get_state preserves exact Chat-only/profile projection, including empty text and reloads", async (t) => {
  for (const chatOnly of [true, false]) {
    const session = inner();
    session.agent.state.systemPrompt = "structured SDK prompt (not sent)";
    let exact = "context/profile only";
    const wrapper = new AgentSessionWrapper(session, { chatOnly, getExactSystemPrompt: () => exact });
    t.after(() => wrapper.destroy());
    assert.equal((await wrapper.send({ type: "get_state" })).systemPrompt, exact);
    exact = "";
    assert.equal((await wrapper.send({ type: "get_state" })).systemPrompt, "");
  }
});

test("RPC and extension navigation refuse streaming, compaction, shell and pending prompts", async (t) => {
  const session = inner();
  session.getActiveToolNames = () => [];
  session.navigateTree = () => assert.fail("must not mutate a busy tree");
  const wrapper = new AgentSessionWrapper(session);
  t.after(() => wrapper.destroy());
  const navigations = [
    () => wrapper.send({ type: "navigate_tree", targetId: "leaf" }),
    () => wrapper.createExtensionCommandContextActions().navigateTree("leaf"),
  ];
  for (const flag of ["isStreaming", "isCompacting", "isBashRunning"]) {
    session[flag] = true;
    for (const navigate of navigations) await assert.rejects(navigate(), /Cannot navigate while the session is running/);
    session[flag] = false;
  }
  let finish;
  session.prompt = (_message, options) => {
    options.preflightResult("started");
    return new Promise((resolve) => { finish = resolve; });
  };
  await wrapper.send({ type: "prompt", message: "extension command not yet streaming" });
  for (const navigate of navigations) await assert.rejects(navigate(), /Cannot navigate/);
  finish();
});

test("tool declarations use prepared descriptions/schemas and guard private SDK compatibility", () => {
  const original = { name: "read", description: "original", parameters: { type: "object" }, promptGuidelines: ["keep"] };
  const prepared = { ...original, description: "prepared", parameters: { type: "object", properties: { path: { type: "string" } } } };
  const session = { agent: { state: { tools: [prepared] } }, getActiveToolNames: () => ["read"], getAllTools: () => [original] };
  for (const value of [undefined, ["read"], new Set([123]), { has: () => true }]) {
    session._hiddenDeclarations = value;
    assert.equal(getModelToolEntries(session)[0].declarationHidden, false);
  }
  session._hiddenDeclarations = new Set(["read"]);
  const [tool] = getModelToolEntries(session);
  assert.equal(tool.description, "prepared");
  assert.equal(tool.parameters, prepared.parameters);
  assert.equal(tool.active, true);
  assert.equal(tool.declarationHidden, true);
  assert.equal(tool.promptGuidelines, original.promptGuidelines);
  Object.defineProperty(session, "_hiddenDeclarations", { get() { throw new Error("changed SDK"); } });
  assert.equal(getModelToolEntries(session)[0].declarationHidden, false);
  session.agent.state = {};
  assert.equal(getModelToolEntries(session)[0].description, "original");
});

test("installed SDK codemode only hides direct declarations without changing the active preset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-declarations-"));
  const sessions = [];
  try {
    const faux = fauxProvider({ models: [{ id: "tools" }] });
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    for (const mode of ["only", "on"]) {
      const services = await createAgentSessionServices({
        cwd: dir, agentDir: dir, modelRuntime,
        settingsManager: SettingsManager.inMemory({ defaultTools: ["+codemode"], codemode: { mode } }),
        resourceLoaderOptions: {
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionFactories: [createCodemodeExtension()],
        },
      });
      const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(dir), model: faux.getModel("tools") });
      sessions.push(session);
      const wrapper = new AgentSessionWrapper(session);
      try {
        const tools = await wrapper.send({ type: "get_tools" });
        const codemode = tools.find((tool) => tool.name === "codemode");
        assert.ok(codemode.active);
        assert.equal(codemode.description, session.agent.state.tools.find((tool) => tool.name === "codemode").description);
        if (mode === "only") assert.notEqual(codemode.description, session.getToolDefinition("codemode").description);
        assert.deepEqual(tools.filter((tool) => tool.declarationHidden).map((tool) => tool.name).sort(), mode === "only" ? ["bash", "edit", "read", "write"] : []);
        assert.deepEqual(tools.filter((tool) => tool.active && !tool.declarationHidden).map((tool) => tool.name).sort(), mode === "only" ? ["codemode"] : ["bash", "codemode", "edit", "read", "write"]);
      } finally { wrapper.destroy(); }
    }
  } finally {
    sessions.forEach((session) => session.dispose());
    await rm(dir, { recursive: true, force: true });
  }
});

test("a prompt on a branch without the runtime's model records it there; pi records the effort", async (t) => {
  const manager = SessionManager.inMemory("/tmp");
  manager.appendModelChange("claude", "opus");
  manager.appendThinkingLevelChange("medium");
  const user = manager.appendMessage({ role: "user", content: "q", timestamp: 1 });
  manager.appendModelChange("sub2api", "gpt"); // chosen on the abandoned branch
  manager.appendThinkingLevelChange("high");
  manager.branch(user); // in-session edit moves the leaf back
  const session = { ...inner(), sessionManager: manager, model: { provider: "sub2api", id: "gpt" }, thinkingLevel: "high" };
  const wrapper = new AgentSessionWrapper(session);
  t.after(() => wrapper.destroy());

  assert.deepEqual(wrapper.liveSelection(), { model: { provider: "sub2api", modelId: "gpt" }, thinkingLevel: "high" });
  wrapper.recordModelOnBranch();
  const context = manager.buildSessionContext();
  assert.deepEqual([context.model, context.thinkingLevel], [{ provider: "sub2api", modelId: "gpt" }, "medium"]);
  // pi 1.5.1 records the (clamped) thinking level on the branch with the prompt (#11451).
  const { importSdkFile } = await createJiti(import.meta.url).import("./builtin-extensions.ts");
  const { AgentSession } = await importSdkFile("core/agent-session.js");
  assert.equal(typeof AgentSession.prototype._recordThinkingLevel, "function");
  const count = manager.getEntries().length;
  wrapper.recordModelOnBranch();
  assert.equal(manager.getEntries().length, count, "already recorded: no duplicate entries");
});

test("RPC set_model during a streamed response changes only the next request and persists the effective choice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-live-model-"));
  let wrapper;
  try {
    const faux = fauxProvider({ models: [{ id: "first" }, { id: "second" }] });
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory();
    const services = await createAgentSessionServices({
      cwd: dir, agentDir: dir, modelRuntime, settingsManager,
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
    });
    const sessionManager = SessionManager.inMemory(dir);
    const { session } = await createAgentSessionFromServices({ services, sessionManager, model: faux.getModel("first"), tools: ["ls"] });
    wrapper = new AgentSessionWrapper(session);
    wrapper.start();
    const models = [];
    faux.setResponses([
      async (_context, _options, _state, model) => {
        models.push(model.id);
        assert.equal(session.isStreaming, true);
        const selected = await wrapper.send({ type: "set_model", provider: model.provider, modelId: "second" });
        assert.deepEqual(selected, { provider: model.provider, id: "second", thinkingLevel: session.thinkingLevel });
        return fauxAssistantMessage([fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" });
      },
      (_context, _options, _state, model) => { models.push(model.id); return fauxAssistantMessage([fauxText("done")]); },
    ]);
    await session.prompt("list the directory");
    assert.deepEqual(models, ["first", "second"]);
    const answers = sessionManager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant");
    assert.deepEqual(answers.map((entry) => entry.message.model), ["first", "second"]);
    assert.equal(settingsManager.getDefaultModel(), "second");
    const count = sessionManager.getEntries().length;
    wrapper.recordModelOnBranch();
    assert.equal(sessionManager.getEntries().length, count, "mid-run set_model already recorded the branch choice");
  } finally {
    wrapper?.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});
