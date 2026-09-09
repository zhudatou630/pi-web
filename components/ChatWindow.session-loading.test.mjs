import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("withholds model, effort, and context controls while an existing session is loading", () => {
  assert.match(source, /const isSessionLoading = !isNew && loading;/);
  assert.match(source, /model=\{isSessionLoading \? null : displayModelValue\}/);
  assert.match(source, /onModelChange=\{isSessionLoading \? undefined : handleModelChange\}/);
  assert.match(source, /thinkingLevel=\{isSessionLoading \? undefined : thinkingLevel\}/);
  assert.match(
    source,
    /onThinkingLevelChange=\{isSessionLoading \? undefined : \(session \|\| isNew \? handleThinkingLevelChange : undefined\)\}/,
  );
  assert.match(source, /contextUsage=\{isSessionLoading \? null : contextUsage\}/);
});
