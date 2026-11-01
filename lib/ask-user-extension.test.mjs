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
  const handlers = {};
  const tools = [{ name: "tool_search", reachesTools: () => "all" }];
  let active = ["read"];
  return {
    tools, handlers,
    get active() { return active; },
    on: (event, handler) => { handlers[event] = handler; },
    registerTool: (tool) => tools.push(tool),
    getAllTools: () => tools,
    getActiveTools: () => active,
    setActiveTools: (names) => { active = names; },
  };
}

test("ask_user comes with the routines tools only: no prompt line of its own", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ask-user-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pi = fakePi();
  createRoutineToolExtension(() => new RoutineStore({ path: join(dir, "routines.json") })).factory(pi);
  assert.equal(pi.tools.find((item) => item.name === ASK_USER_TOOL_NAME).exposure, "deferred");
  pi.handlers.session_start();
  const event = { systemPromptOptions: { selectedTools: pi.active, sections: {} } };
  pi.handlers.before_agent_start(event);
  assert.deepEqual(Object.keys(event.systemPromptOptions.sections), ["routines"]);
  assert.doesNotMatch(event.systemPromptOptions.sections.routines, /ask_user/);
  assert.match(pi.tools.find((item) => item.name === "create_routine").description, /ask with ask_user/);

  // Whatever tool_search found of the routines set (even with limit: 1), the whole set comes in
  // one tool addition: one prompt-cache break.
  pi.handlers.tool_result({ toolName: "read", details: { loaded: ["create_routine"] } });
  assert.deepEqual(pi.active, ["read", "tool_search"]);
  pi.handlers.tool_result({ toolName: "tool_search", details: { loaded: ["something_else"] } });
  assert.deepEqual(pi.active, ["read", "tool_search"]);
  pi.active.push("create_routine"); // what tool_search itself activated
  pi.handlers.tool_result({ toolName: "tool_search", details: { loaded: ["create_routine"] } });
  assert.deepEqual(pi.active, ["read", "tool_search", "create_routine", "list_routines", "update_routine", ASK_USER_TOOL_NAME]);
  pi.handlers.tool_result({ toolName: "tool_search", details: { loaded: ["list_routines"] } });
  assert.equal(pi.active.length, 6);
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
