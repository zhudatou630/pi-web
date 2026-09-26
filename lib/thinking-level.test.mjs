import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { clampThinkingLevelTo, THINKING_LEVELS } = await jiti.import("./thinking-level.ts");

test("clampThinkingLevelTo matches pi-ai clampThinkingLevel", () => {
  const models = [
    { reasoning: true, thinkingLevelMap: {} },
    { reasoning: true, thinkingLevelMap: { minimal: null, medium: null } },
    { reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: null } },
    { reasoning: false },
  ];
  for (const model of models) {
    const available = getSupportedThinkingLevels(model);
    for (const level of THINKING_LEVELS) {
      assert.equal(
        clampThinkingLevelTo(available, level),
        clampThinkingLevel(model, level),
        `available=${available.join(",")} level=${level}`,
      );
    }
  }
});

test("clampThinkingLevelTo keeps missing-model data untouched", () => {
  assert.equal(clampThinkingLevelTo(undefined, "max"), "max");
  assert.equal(clampThinkingLevelTo([], "low"), "low");
});
