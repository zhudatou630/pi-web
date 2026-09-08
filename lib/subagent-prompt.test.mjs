import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { buildSubagentPromptPlan } = await createJiti(import.meta.url).import("./subagent-prompt.ts");

test("a tool-free subagent uses only its profile as the exact system prompt", () => {
  const plan = buildSubagentPromptPlan({
    profileSystemPrompt: "Review carefully.",
    tools: [],
    task: "Inspect the parser.",
    inheritedParentContext: "Parent context",
  });

  assert.equal(plan.chatOnly, true);
  assert.equal(plan.exactSystemPrompt, "Review carefully.");
  assert.deepEqual(plan.appendSystemPrompt, ["Review carefully."]);
  assert.equal(plan.delegatedTask, "Inspect the parser.\n\nParent context");
});

test("a tool-enabled subagent retains inherited context in its appended system prompt", () => {
  const plan = buildSubagentPromptPlan({
    profileSystemPrompt: "Explore carefully.",
    tools: ["read"],
    task: "Inspect the parser.",
    inheritedParentContext: "Parent context",
  });

  assert.equal(plan.chatOnly, false);
  assert.equal(plan.exactSystemPrompt, undefined);
  assert.deepEqual(plan.appendSystemPrompt, ["Explore carefully.", "Parent context"]);
  assert.equal(plan.delegatedTask, "Inspect the parser.");
});

test("project instructions remain a distinct persisted prompt layer", () => {
  const plan = buildSubagentPromptPlan({
    profileSystemPrompt: "Work autonomously.",
    projectInstructions: "Follow AGENTS.md.",
    tools: ["read", "edit"],
    task: "Fix the parser.",
  });

  assert.deepEqual(plan.appendSystemPrompt, ["Work autonomously.", "Follow AGENTS.md."]);
  assert.equal(plan.exactSystemPrompt, undefined);
});

test("a resource-enabled tool-free subagent keeps the normal system prompt pipeline", () => {
  for (const resources of [
    { loadSkills: true, loadExtensions: false },
    { loadSkills: false, loadExtensions: true },
  ]) {
    const plan = buildSubagentPromptPlan({
      profileSystemPrompt: "Use loaded resources.",
      tools: [],
      ...resources,
      task: "Inspect the parser.",
      inheritedParentContext: "Parent context",
    });

    assert.equal(plan.chatOnly, false);
    assert.equal(plan.exactSystemPrompt, undefined);
    assert.deepEqual(plan.appendSystemPrompt, ["Use loaded resources.", "Parent context"]);
    assert.equal(plan.delegatedTask, "Inspect the parser.");
  }
});
