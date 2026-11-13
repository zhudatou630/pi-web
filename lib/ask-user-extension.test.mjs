import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { registerAskUserTool, ASK_USER_TOOL_NAME } = await jiti.import("./ask-user-extension.ts");
const { createRoutineToolExtension } = await jiti.import("./routine-tool-extension.ts");
const { RoutineStore } = await jiti.import("./routines.ts");

function fakePi() {
  const tools = [];
  return { tools, on: () => {}, registerTool: (tool) => tools.push(tool), getActiveTools: () => [] };
}

test("ask_user comes with the routines tools only, scoped to setting one up", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ask-user-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pi = fakePi();
  createRoutineToolExtension(() => new RoutineStore({ path: join(dir, "routines.json") })).factory(pi);
  const tool = pi.tools.find((item) => item.name === ASK_USER_TOOL_NAME);
  assert.equal(tool.exposure, "model-only");
  assert.match(tool.description, /^While setting up a routine/);
  assert.match(pi.tools.find((item) => item.name === "create_routine").description, /ask with ask_user/);
});

test("ask_user ends the turn without waiting", async () => {
  const pi = fakePi();
  registerAskUserTool(pi);
  const tool = pi.tools.find((item) => item.name === ASK_USER_TOOL_NAME);

  const asked = await tool.execute("q1", { question: " Which? ", options: [" A ", "B"], multi_select: true });
  assert.equal(asked.terminate, true);
  assert.deepEqual(asked.details, { question: "Which?", options: ["A", "B"], multi_select: true });

  // "!x" / "/x" would run a shell or slash command when the clicked answer is sent.
  for (const options of [["A"], ["A", "A"], ["A", "B\nC"], ["A", "B".repeat(81)], ["A", "!rm -rf ~"], ["A", "/compact"]]) {
    const bad = await tool.execute("q2", { question: "Which?", options });
    assert.equal(bad.isError, true);
    assert.equal(bad.terminate, undefined);
  }
});
