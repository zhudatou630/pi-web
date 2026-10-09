import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

// Pins the SDK contract the streaming composer control relies on.
test("a thinking level changed while streaming applies to the next model request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-thinking-mid-run-"));
  let session;
  try {
    const faux = fauxProvider({ models: [{ id: "faux-reasoner", reasoning: true }] });
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const services = await createAgentSessionServices({
      cwd: dir, agentDir: dir, modelRuntime, settingsManager: SettingsManager.inMemory(),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
    });
    ({ session } = await createAgentSessionFromServices({
      services, model: faux.getModel("faux-reasoner"), thinkingLevel: "low", tools: ["ls"], sessionManager: SessionManager.inMemory(dir),
    }));
    const levels = [];
    faux.setResponses([
      (_context, options) => {
        levels.push(options?.reasoning);
        assert.equal(session.isStreaming, true);
        session.setThinkingLevel("high");
        return fauxAssistantMessage([fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" });
      },
      (_context, options) => {
        levels.push(options?.reasoning);
        return fauxAssistantMessage([fauxText("done")]);
      },
    ]);
    await session.prompt("list the directory");
    assert.deepEqual(levels, ["low", "high"]);
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
