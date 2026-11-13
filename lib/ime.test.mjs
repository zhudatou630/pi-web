import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
const { isImeComposing } = await createJiti(import.meta.url).import("./ime.ts");

test("IME guards handle native, React and legacy keyboard events", () => {
  for (const event of [{ isComposing: true }, { keyCode: 229 }, { nativeEvent: { isComposing: true } }, { nativeEvent: {}, keyCode: 229 }]) {
    assert.equal(isImeComposing(event), true);
  }
  assert.equal(isImeComposing({ nativeEvent: { isComposing: false, keyCode: 13 } }), false);
});

test("plugin installation and skill search ignore composition and duplicate searches", async () => {
  const plugin = await readFile(new URL("../components/PluginsConfig.tsx", import.meta.url), "utf8");
  const skill = await readFile(new URL("../components/SkillsConfig.tsx", import.meta.url), "utf8");
  assert.match(plugin, /if \(isImeComposing\(e\)\) return;\s*if \(e.key === "Enter" && source.trim\(\) && !busy\)/);
  assert.match(skill, /if \(isImeComposing\(e\)\) return;\s*if \(e.key === "Enter" && !searching\)/);
  assert.match(skill, /if \(!q.trim\(\) \|\| searchInFlight.current\) return;/);
  assert.match(skill, /finally \{\s*searchInFlight.current = false;/);
});
