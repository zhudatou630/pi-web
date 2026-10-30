import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSubagentController } = await jiti.import("./subagent-runtime.ts");
const { createSubagentExtension, subagentFinalText } = await jiti.import("./subagent-extension.ts");
const exec = promisify(execFile);
const git = (cwd, ...args) => exec("git", ["-C", cwd, ...args]);

for (const outcome of ["clean", "committed", "failed", "missing"]) {
  test(`isolated ${outcome} outcome reaches tools, notifications and cold file read-back`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-cleanup-result-"));
    const globals = ["__piSubagentRuns", "__piSubagentQueue", "__piSubagentWaves", "__piSubagentNotificationParents", "__piSubagentResumeClaims"];
    const previous = globals.map((key) => globalThis[key]);
    for (const key of globals) globalThis[key] = undefined;
    let checkout;
    t.after(async () => {
      for (const wave of globalThis.__piSubagentWaves?.values() ?? []) clearTimeout(wave.notifyTimer);
      globals.forEach((key, index) => { globalThis[key] = previous[index]; });
      if (checkout) await rm(checkout, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    });
    await git(dir, "init", "-q");
    await git(dir, "config", "user.name", "Pi Test");
    await git(dir, "config", "user.email", "test@example.com");
    await writeFile(join(dir, "initial.txt"), "initial");
    await git(dir, "add", ".");
    await git(dir, "commit", "-qm", "initial");
    const sessionPath = join(dir, "child.jsonl");
    const timestamp = new Date().toISOString();
    const entries = [{ type: "custom", customType: "pi-web:subagent", id: "meta", parentId: null, timestamp, data: {
      version: 1, parentSessionId: "parent", parentSessionPath: join(dir, "parent.jsonl"),
      parentToolCallId: "old-call", profile: "explore", description: "Cleanup test", task: "test",
      isolation: "worktree", createdAt: timestamp, runInBackground: true,
    } }];
    const save = () => writeFileSync(sessionPath, [
      { type: "session", version: 3, id: "child", cwd: dir, timestamp }, ...entries,
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    save();
    const manager = {
      getEntries: () => entries,
      appendCustomEntry(customType, data) {
        entries.push({ type: "custom", customType, data, id: `entry-${entries.length}`, parentId: entries.at(-1).id, timestamp });
        save();
      },
    };
    const sent = [];
    const parent = {
      cwd: dir, isAlive: () => true, isClosing: () => false, isRunning: () => false,
      inner: { subscribe: () => () => {}, sendCustomMessage: async (message) => { sent.push(message); } },
    };
    let child = {
      cwd: dir, sessionFile: sessionPath, inner: { sessionManager: manager },
      isAlive: () => true, isClosing: () => false, isRunning: () => false, shutdown: async () => {},
    };
    const controller = createSubagentController({
      getSession: (id) => id === "parent" ? parent : child,
      registerSession() {}, resolveSessionPath: async () => sessionPath, invalidateSessionList() {},
      isSubagentsEnabled: () => true,
      async reopenSession(_id, _path, cwd) {
        checkout = cwd;
        child = { ...child, cwd, waitUntilReady: async () => {}, inner: {
          sessionManager: manager, agent: { state: { messages: [] } },
          async prompt() {
            if (outcome !== "clean") await writeFile(join(cwd, "child.txt"), "child changes");
            if (outcome === "missing") {
              await git(cwd, "add", "child.txt");
              await git(cwd, "commit", "-qm", "child saved its own work");
              await git(cwd, "branch", "child-saved-work");
              await git(dir, "worktree", "remove", cwd);
            }
            if (outcome === "failed") {
              await git(cwd, "config", "user.name", "");
              await git(cwd, "config", "user.email", "");
            }
            this.agent.state.messages.push({ role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" });
          },
        } };
        return child;
      },
    });
    const context = { sessionManager: { getSessionId: () => "parent", getBranch: () => [], getEntries: () => [] } };
    const execution = await controller.extensionRuntime.resume({
      parentContext: context, parentToolCallId: "new-call", sessionId: "child", task: "test", description: "Cleanup test", runInBackground: true,
    });
    const run = await execution.completion;
    const text = subagentFinalText(run);
    assert.equal(run.worktreeCleanup, outcome === "failed" ? "kept" : outcome === "missing" ? "missing" : "removed");
    if (outcome === "failed") {
      await stat(checkout);
      assert.match(text, /cleanup failed; checkout kept at .*Could not commit checkout changes/);
    } else {
      await assert.rejects(stat(checkout));
      assert.equal(run.worktreePath, undefined);
      assert.match(text, outcome === "missing"
        ? /checkout already missing; change state unknown\. Check repository branches for commits/
        : outcome === "clean" ? /no changes; checkout removed/ : /changes committed to branch .*; checkout removed/);
      if (outcome === "missing") {
        assert.doesNotMatch(text, /no changes|changes committed to branch/);
        assert.equal((await git(dir, "show", "child-saved-work:child.txt")).stdout, "child changes");
      }
      if (outcome === "committed") assert.equal((await git(dir, "show", `${run.worktreeBranch}:child.txt`)).stdout, "child changes");
    }
    controller.flushParentNotifications("parent");
    assert.ok(sent[0].content.includes(text));

    // No live wrapper or run registry: get_subagent_result must recover the same note from JSONL.
    const cold = createSubagentController({ getSession: () => undefined, registerSession() {}, resolveSessionPath: async () => sessionPath, invalidateSessionList() {} });
    const tools = new Map();
    await createSubagentExtension(cold.extensionRuntime, () => [{ name: "explore", enabled: true, tools: [] }]).factory({
      registerTool: (tool) => tools.set(tool.name, tool), on() {},
    });
    const readBack = await tools.get("get_subagent_result").execute("get", { agent_id: "child" }, undefined, undefined, context);
    assert.equal(readBack.content[0].text, text);
    assert.equal(subagentFinalText(await cold.get("child")), text);
  });
}
