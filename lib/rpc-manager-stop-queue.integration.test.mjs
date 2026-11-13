import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const { AgentSessionWrapper } = await createJiti(import.meta.url).import("./rpc-manager.ts");
for (const mode of ["one-at-a-time", "all"]) {
  test(`installed SDK: Stop clears every delivery before abort, preserving custom history (${mode})`, { timeout: 8000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-stop-sdk-"));
    const started = Promise.withResolvers();
    const faux = fauxProvider({ models: [{ id: "stop" }] });
    const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    const services = await createAgentSessionServices({ cwd: root, agentDir: root, modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory({ steeringMode: mode }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
    });
    const { session } = await createAgentSessionFromServices({ services, model: faux.getModel("stop"), sessionManager: SessionManager.inMemory(root),
      customTools: [{ name: "wait", label: "wait", description: "wait for Stop", parameters: { type: "object", properties: {} },
        async execute(_id, _params, signal) {
          started.resolve();
          if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          return { content: [{ type: "text", text: "stopped" }], details: {} };
        },
      }],
    });
    const wrapper = new AgentSessionWrapper(session); wrapper.start();
    t.after(async () => { await session.abort(); wrapper.destroy(); await rm(root, { recursive: true, force: true }); });
    faux.setResponses([fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("next reply")])]);
    await wrapper.send({ type: "prompt", message: "start" }); await started.promise;
    await wrapper.send({ type: "prompt", message: "one", streamingBehavior: "steer" });
    await wrapper.send({ type: "prompt", message: "two", streamingBehavior: "steer" });
    await wrapper.send({ type: "prompt", message: "later", streamingBehavior: "followUp" });
    await session.sendCustomMessage({ customType: "note", content: "preserved", display: true, details: { keep: true } }, { deliverAs: "steer" });
    const recalled = await wrapper.send({ type: "abort" });
    assert.deepEqual(recalled.steering.map((prompt) => prompt.text), ["one", "two"]);
    assert.deepEqual(recalled.followUp.map((prompt) => prompt.text), ["later"]);
    for (let i = 0; wrapper.isRunning() && i < 100; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(wrapper.isRunning(), false);
    const users = () => session.messages.filter((message) => message.role === "user").map((message) => typeof message.content === "string" ? message.content : message.content[0].text);
    assert.deepEqual(users(), ["start"]);
    assert.ok(session.messages.some((message) => message.role === "custom" && message.customType === "note" && message.details.keep));
    await wrapper.send({ type: "prompt", message: "next" });
    for (let i = 0; wrapper.isRunning() && i < 100; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(users(), ["start", "next"]);
  });
}
