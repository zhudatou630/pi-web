import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("expands process details when a completed turn has no final answer", () => {
  assert.match(source, /const \[expanded, setExpanded\] = useState\(defaultExpanded\)/);
  assert.match(
    source,
    /<ProcessDetailsGroup[\s\S]*?defaultExpanded=\{!finalAnswerMessage && endIdx === messages.length\}/,
  );
  assert.match(source, /if \(userToggledRef\.current\) return;\s*setExpanded\(defaultExpanded\)/);
});

test("marks only the separated final answer as the end of a turn", () => {
  assert.match(source, /renderMessage\(finalAssistantIdx, \{\s*isTurnEnd: true,\s*messageOverride: finalAnswerMessage/);
  assert.equal((source.match(/isTurnEnd: true/g) ?? []).length, 1);
  assert.match(source, /isTurnEnd=\{options\.isTurnEnd\}/);
  assert.doesNotMatch(source, /let isTurnEnd/);
});

test("folds a leading process prefix that has no user anchor", () => {
  assert.match(source, /const hasAnchor = isMessageGroupAnchor\(messages\[idx\]\)/);
  assert.match(source, /const userIdx = hasAnchor \? idx : -1/);
  assert.match(source, /if \(hasAnchor\) \{\s*markOutlineTarget\(\[entryIds\[userIdx\]\]\);\s*rendered\.push\(renderMessage\(userIdx\)\);\s*\}/);
  assert.doesNotMatch(
    source,
    /if \(!isMessageGroupAnchor\(msg\)\) \{\s*rendered\.push\(renderMessage\(idx\)\)/,
  );
});

test("passes activeStepSummary and renders telemetry indicator when streaming", () => {
  assert.match(source, /activeStepSummary=\{activeStepSummary\}/);
  assert.match(source, /isStreaming=\{liveProcessActive\}/);
  assert.match(source, /animate-pulse/);
  assert.doesNotMatch(source, /chat\.thinkingProgress/);
});

test("streams process blocks inside steps and answer blocks outside", () => {
  assert.match(source, /partitionAssistantMessage\(/);
  assert.match(source, /message=\{streamingParts\.processMessage\}/);
  assert.match(source, /message=\{streamingParts\.answerMessage\}/);
  assert.doesNotMatch(source, /isStreamingProcess && streamState\.streamingMessage/);
});
