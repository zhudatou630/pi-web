import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("withholds model, effort, and context controls while an existing session is loading", () => {
  assert.match(source, /const isSessionLoading = !isNew && loading;/);
  assert.match(source, /model=\{isSessionLoading \? null : displayModelValue\}/);
  assert.match(source, /isStreaming=\{sessionBusy \|\| isQueuedSubagent\}/);
  assert.match(source, /onModelChange=\{isSessionLoading \|\| isQueuedSubagent \? undefined : handleModelChange\}/);
  assert.match(source, /thinkingLevel=\{isSessionLoading \? undefined : thinkingLevel \?\? undefined\}/);
  assert.match(
    source,
    /onThinkingLevelChange=\{isSessionLoading \|\| isQueuedSubagent \? undefined : \(session \|\| isNew \? handleThinkingLevelChange : undefined\)\}/,
  );
  assert.match(source, /contextUsage=\{isSessionLoading \? null : contextUsage\}/);
});

test("only a load that produced nothing replaces the chat; a failed refresh keeps it", () => {
  assert.match(source, /if \(error && !data\) \{\n\s+return \(\n\s+<div role="alert"/);
  assert.match(source, /onClick=\{retryLoadSession\}/);
  assert.doesNotMatch(source, /if \(error\) \{\n\s+return/);
});
