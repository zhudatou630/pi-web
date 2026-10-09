import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentTools, Type } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSubagentController, createSubagentShellTools } = await jiti.import("./subagent-runtime.ts");
const { createSubagentExtension } = await jiti.import("./subagent-extension.ts");
const { readSubagentSessionResources } = await jiti.import("./subagents.ts");
const answer = (text) => fauxAssistantMessage([fauxText(text)]);
const call = (name, args, text) => fauxAssistantMessage([
  ...(text ? [fauxText(text)] : []), fauxToolCall(name, args),
], { stopReason: "toolUse" });
const saw = (context, text) => context.messages.some((message) => message.role === "user" &&
  message.content.some((block) => block.type === "text" && block.text.includes(text)));

async function withRuntime(check, configureChild) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-subagent-safety-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const sessions = new Map();
  const paths = new Map();
  const opened = [];
  try {
    await mkdir(join(dir, "agents"));
    await writeFile(join(dir, "agents", "fixture.md"), "---\ntools: read, bash\n---\nComplete the task.\n");
    const fact = join(dir, "fact.txt");
    await writeFile(fact, "42\n");
    const faux = fauxProvider({ models: [{ id: "faux-model" }] });
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    async function makeSession(manager, options = {}) {
      const services = await createAgentSessionServices({
        cwd: dir, agentDir: dir, modelRuntime, settingsManager: SettingsManager.inMemory(),
        resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
      });
      const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model: faux.getModel("faux-model"), ...options });
      return session;
    }
    const parent = await makeSession(SessionManager.create(dir, join(dir, "sessions")));
    const registerSession = (inner) => {
      opened.push(inner);
      if (inner !== parent) configureChild?.(inner);
      const wrapper = {
        inner, cwd: dir, sessionFile: inner.sessionFile, isAlive: () => true, isClosing: () => false,
        isRunning: () => inner.isStreaming, waitUntilReady: async () => {}, shutdown: async () => inner.dispose(),
      };
      sessions.set(inner.sessionId, wrapper);
      paths.set(inner.sessionId, inner.sessionFile);
      return wrapper;
    };
    registerSession(parent);
    const controller = createSubagentController({
      getSession: (id) => sessions.get(id), registerSession,
      resolveSessionPath: async (id) => paths.get(id) ?? null,
      reopenSession: async (_id, path) => {
        const manager = SessionManager.open(path);
        const resources = readSubagentSessionResources(manager.getEntries());
        return registerSession(await makeSession(manager, {
          tools: resources.tools,
          customTools: createSubagentShellTools(dir, SettingsManager.inMemory()),
        }));
      },
      invalidateSessionList() {}, isSubagentsEnabled: () => true,
    });
    const request = {
      parentContext: { sessionManager: parent.sessionManager }, parentToolCallId: "fixture-call",
      profile: "fixture", task: "Read the fact and report.", description: "Fixture", runInBackground: false,
    };
    await check({ dir, controller, runtime: controller.extensionRuntime, request, faux, fact, sessions, modelRuntime });
  } finally {
    for (const inner of opened) inner.dispose();
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

test("real SDK declares model-only controls but refuses ctx.executeTool calls", async () => {
  await withRuntime(async ({ modelRuntime, dir, faux }) => {
    const calls = [];
    const nested = [];
    const controls = ["Agent", "get_subagent_result", "steer_subagent"];
    const runtime = {
      async start() { calls.push("start"); throw new Error("must not start"); },
      async steer() { calls.push("steer"); },
      async get() {
        calls.push("get");
        return { sessionId: "child", status: "completed", result: "RESULT", parentSessionId: "parent" };
      },
      consume() {},
    };
    const services = await createAgentSessionServices({
      cwd: dir, agentDir: dir, modelRuntime, settingsManager: SettingsManager.inMemory(),
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [
          createSubagentExtension(runtime, () => [{ name: "fixture", enabled: true, tools: [], description: "Fixture" }]),
          (pi) => pi.registerTool({
            name: "script", label: "script", description: "Nested calls", parameters: Type.Object({}),
            async execute(_id, _params, _signal, _update, ctx) {
              for (const [name, args] of [
                ["Agent", { prompt: "Task", description: "Task" }],
                ["get_subagent_result", { agent_id: "child" }],
                ["steer_subagent", { agent_id: "child", message: "Focus" }],
              ]) nested.push(await ctx.executeTool(name, args));
              return { content: [{ type: "text", text: "Done" }], details: undefined };
            },
          }),
        ],
      },
    });
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(dir), model: faux.getModel("faux-model") });
    try {
      for (const name of controls) {
        assert.equal(session.getAllTools().find((tool) => tool.name === name)?.exposure, "model-only");
        assert.ok(session.getActiveToolNames().includes(name));
        assert.ok(!session.getCallableToolNames().includes(name));
      }
      faux.setResponses([
        (context) => {
          for (const name of controls) assert.ok(getCurrentTools(context.messages).some((tool) => tool.name === name));
          return call("get_subagent_result", { agent_id: "child" });
        },
        call("script", {}), answer("done"),
      ]);
      await session.prompt("Check result and nested calls");
      assert.deepEqual(calls, ["get"]);
      assert.equal(nested.length, 3);
      for (const outcome of nested) assert.equal(outcome.isError, true);
      const result = session.messages.find((message) => message.role === "toolResult" && message.toolName === "get_subagent_result");
      assert.equal(result.isError, false);
      assert.equal(result.content[0].text, "RESULT");
    } finally { session.dispose(); }
  });
});

test("turn budget clears late steering/follow-ups, overrides continue, refuses late steer, and resets on resume", async () => {
  let controllerForSteer;
  let lateSteer;
  await withRuntime(async ({ runtime, controller, request, faux, fact, sessions }) => {
    controllerForSteer = controller;
    let sessionId;
    faux.setResponses([
      async () => {
        await controller.steer(sessionId, "EARLY_NOTE");
        return call("read", { path: fact });
      },
      async (context) => {
        assert.ok(saw(context, "EARLY_NOTE"));
        assert.ok(saw(context, "You have reached your turn limit"));
        await controller.steer(sessionId, "LATE_STEER");
        await sessions.get(sessionId).inner.followUp("LATE_FOLLOWUP");
        return call("read", { path: fact }, "PARTIAL");
      },
      answer("PAST_THE_LIMIT"),
    ]);
    const execution = await runtime.start({ ...request, maxTurns: 1 });
    sessionId = execution.run.sessionId;
    const result = await execution.completion;
    const inner = sessions.get(sessionId).inner;
    assert.equal(faux.state.callCount, 2);
    assert.equal(result.status, "failed");
    assert.equal(result.result, "PARTIAL");
    assert.match(result.error, /LATE_STEER/);
    assert.match(result.error, /LATE_FOLLOWUP/);
    assert.match(result.error, /HOOK_NOTE/);
    assert.match(await lateSteer, /turn limit/);
    assert.equal(inner.pendingMessageCount, 0);
    assert.equal(inner.agent.steeringMode, "one-at-a-time");
    faux.setResponses([(context) => {
      for (const text of ["LATE_STEER", "LATE_FOLLOWUP", "HOOK_NOTE"]) assert.equal(saw(context, text), false);
      return answer("RESUMED");
    }]);
    const resumed = await runtime.resume({ ...request, sessionId, task: "Continue" });
    assert.equal((await resumed.completion).result, "RESUMED");
  }, (inner) => {
    inner.subscribe((event) => {
      if (event.type === "turn_end" && event.message.content.some((block) => block.text === "PARTIAL")) {
        lateSteer ??= controllerForSteer.steer(inner.sessionId, "TOO_LATE").then(() => "accepted", (error) => error.message);
      }
    });
    const previous = inner.agent.finishTurn;
    inner.agent.finishTurn = async (turn, signal) => {
      const decision = await previous?.(turn, signal);
      if (!turn.message.content.some((block) => block.text === "PARTIAL")) return decision;
      await inner.steer("HOOK_NOTE");
      return { action: "continue" };
    };
  });
});

test("queued work and a handler continuation cannot bypass a natural-answer turn limit", async () => {
  await withRuntime(async ({ runtime, request, faux, sessions }) => {
    faux.setResponses([answer("FIRST"), answer("FINAL"), answer("PAST_THE_LIMIT")]);
    const execution = await runtime.start({ ...request, maxTurns: 1 });
    const result = await execution.completion;
    assert.equal(faux.state.callCount, 2);
    assert.equal(result.status, "completed");
    assert.equal(result.result, "FINAL");
    assert.equal(result.wrappedAtTurnLimit, true);
    assert.equal(sessions.get(result.sessionId).inner.pendingMessageCount, 0);
  }, (inner) => {
    const previous = inner.agent.finishTurn;
    inner.agent.finishTurn = async (turn, signal) => {
      const decision = await previous?.(turn, signal);
      return turn.message.content.some((block) => block.text === "FIRST") ? { action: "continue" } : decision;
    };
  });
});

test("a follow-up queued at natural completion is reported instead of exceeding the budget", async () => {
  await withRuntime(async ({ runtime, request, faux, sessions }) => {
    faux.setResponses([answer("FIRST"), answer("FINAL"), answer("PAST_THE_LIMIT")]);
    const execution = await runtime.start({ ...request, maxTurns: 1 });
    const result = await execution.completion;
    assert.equal(faux.state.callCount, 2);
    assert.equal(result.status, "failed");
    assert.equal(result.result, "FINAL");
    assert.match(result.error, /QUEUED_FOLLOWUP/);
    assert.equal(sessions.get(result.sessionId).inner.pendingMessageCount, 0);
  }, (inner) => {
    const previous = inner.agent.finishTurn;
    inner.agent.finishTurn = async (turn, signal) => {
      const decision = await previous?.(turn, signal);
      if (turn.message.content.some((block) => block.text === "FIRST")) await inner.followUp("QUEUED_FOLLOWUP");
      return decision;
    };
  });
});

test("a finalized terminating tool does not receive an unnecessary wrap-up turn", async () => {
  await withRuntime(async ({ runtime, request, faux, fact }) => {
    faux.setResponses([call("read", { path: fact }, "TERMINAL"), answer("REVIVED")]);
    const result = await (await runtime.start({ ...request, maxTurns: 1 })).completion;
    assert.equal(faux.state.callCount, 1);
    assert.equal(result.status, "completed");
    assert.equal(result.result, "TERMINAL");
  }, (inner) => {
    const previous = inner.agent.afterToolCall;
    inner.agent.afterToolCall = async (context, signal) => ({
      ...await previous?.(context, signal), terminate: true,
    });
  });
});

test("shell overrides neither activate unselected tools nor replace user extension shells", () => {
  const defaults = createSubagentShellTools(tmpdir(), SettingsManager.inMemory());
  assert.deepEqual(defaults.map((tool) => tool.name), ["bash", "powershell"]);
  assert.ok(defaults.every((tool) => tool.defaultActive === false));
  const userTools = [{ tools: new Map([["bash", {}], ["powershell", {}]]) }];
  assert.deepEqual(createSubagentShellTools(tmpdir(), SettingsManager.inMemory(), userTools), []);
});

test("default bash scrubs the web password on spawn and cold reopen without losing SDK env", async () => {
  const old = process.env.PI_WEB_PASSWORD;
  process.env.PI_WEB_PASSWORD = "fixture-web-secret";
  try {
    await withRuntime(async ({ runtime, request, faux, sessions }) => {
      const command = `node -e 'console.log(JSON.stringify({password:process.env.PI_WEB_PASSWORD,session:process.env.PI_SESSION_ID}))'`;
      for (const phase of ["spawn", "reopen"]) {
        faux.setResponses([call("bash", { command }), answer("DONE")]);
        const execution = phase === "spawn" ? await runtime.start(request) : await runtime.resume({ ...request, sessionId: request.sessionId });
        const result = await execution.completion;
        assert.equal(result.status, "completed");
        const inner = sessions.get(result.sessionId).inner;
        const output = inner.messages.filter((message) => message.role === "toolResult" && message.toolName === "bash").at(-1);
        const env = JSON.parse(output.content[0].text);
        assert.equal(env.password, undefined);
        assert.equal(env.session, result.sessionId);
        assert.doesNotMatch(await readFile(inner.sessionFile, "utf8"), /fixture-web-secret/);
        request.sessionId = result.sessionId;
        if (phase === "spawn") { inner.dispose(); sessions.delete(result.sessionId); }
      }
      // The production cold-open path must use the same safe definitions as this SDK fixture.
      const rpc = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
      assert.match(rpc, /customTools: createSubagentShellTools\(sessionCwd, settingsManager/);
    });
  } finally {
    if (old === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = old;
  }
});

test("default PowerShell uses scrubbed operations too", { skip: process.platform !== "win32" }, async () => {
  const old = process.env.PI_WEB_PASSWORD;
  process.env.PI_WEB_PASSWORD = "fixture-web-secret";
  try {
    await withRuntime(async ({ dir }) => {
      const tool = createSubagentShellTools(dir, SettingsManager.inMemory()).find((tool) => tool.name === "powershell");
      const result = await tool.execute("shell", {
        command: "@{ password=$env:PI_WEB_PASSWORD; session=$env:PI_SESSION_ID } | ConvertTo-Json -Compress",
      }, undefined, undefined, { model: undefined, thinkingLevel: "off", sessionManager: { getSessionId: () => "ps-session", getSessionFile: () => undefined } });
      const env = JSON.parse(result.content[0].text);
      assert.ok(!env.password);
      assert.equal(env.session, "ps-session");
    });
  } finally {
    if (old === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = old;
  }
});
