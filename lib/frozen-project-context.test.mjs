import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
// Not exported by the SDK; the same functions AgentSession uses to decide on a section patch.
import {
  buildSystemPromptSections,
  diffSystemPromptSections,
  normalizeBuildSystemPromptOptions,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { freezeProjectContext } = await jiti.import("./frozen-project-context.ts");

const options = (content) => ({ cwd: "/p", contextFiles: content ? [{ path: "/p/AGENTS.md", content }] : [] });

function patchAfterRestart(started, onDisk) {
  let handler;
  freezeProjectContext({ on: (event, fn) => { if (event === "before_agent_start") handler = fn; } });
  const branch = started === undefined ? [] : [
    { type: "message", message: { role: "system", content: "", timestamp: 1, sections: buildSystemPromptSections(options(started)) } },
    { type: "message", message: { role: "user", content: "hi" } },
  ];
  const event = { systemPromptOptions: normalizeBuildSystemPromptOptions(options(onDisk)) };
  handler(event, { sessionManager: { getBranch: () => branch } });
  const recorded = branch[0]?.message.sections ?? {};
  return diffSystemPromptSections(recorded, buildSystemPromptSections(event.systemPromptOptions));
}

test("a session keeps the context files it started with", () => {
  assert.equal(patchAfterRestart("old rules", "new rules"), undefined);
  assert.equal(patchAfterRestart("old rules", undefined), undefined, "file deleted since");
  assert.ok(patchAfterRestart(undefined, "rules")?.project_context, "a new session reads the disk");
});

test("a session started without context files does not gain them", () => {
  let handler;
  freezeProjectContext({ on: (_, fn) => { handler = fn; } });
  const branch = [{ type: "message", message: { role: "system", content: "", timestamp: 1, sections: buildSystemPromptSections(options()) } }];
  const event = { systemPromptOptions: normalizeBuildSystemPromptOptions(options("added later")) };
  handler(event, { sessionManager: { getBranch: () => branch } });
  assert.equal(diffSystemPromptSections(branch[0].message.sections, buildSystemPromptSections(event.systemPromptOptions)), undefined);
});
