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
  assert.match(source, /<LivePulseBeacon/);
  assert.doesNotMatch(source, /chat\.thinkingProgress/);
});

test("live process summary is coarse, latched, and omits tool details", () => {
  assert.doesNotMatch(source, /function formatToolCallSummary/);
  assert.match(source, /if \(lastBlock\?\.type === "thinking"\) return t\("chat\.thinking"\)/);
  assert.match(source, /if \(lastBlock\?\.type === "toolCall"\) return lastBlock\.toolName/);
  assert.match(source, /function latchedLiveProcessSummary/);
  assert.match(source, /return latched\.current \?\? fallback/);
  assert.doesNotMatch(source, /chat\.generatingToolInput/);
});

test("uses a visual placeholder instead of textual agent phase rows", () => {
  assert.match(source, /function ActivityPulse/);
  assert.match(source, /agentRunning && !hasStreamingContent && !currentTurnHasVisibleOutput/);
  assert.doesNotMatch(source, /function phaseLabel/);
  assert.doesNotMatch(source, /chat\.waitingModel/);
  assert.doesNotMatch(source, /chat\.runningCommand/);
});

test("streams process blocks inside steps and answer blocks outside", () => {
  assert.match(source, /partitionAssistantMessage\(/);
  assert.match(source, /message=\{streamingParts\.processMessage\}/);
  assert.match(source, /message=\{streamingParts\.answerMessage\}/);
  assert.doesNotMatch(source, /isStreamingProcess && streamState\.streamingMessage/);
});

test("keeps completed turn projections stable while only the streaming tail changes", () => {
  assert.match(source, /const completedAssistantParts = useMemo\(\(\) => messages\.map/);
  assert.match(source, /const writtenFilesByAssistantIndex = useMemo/);
  assert.match(source, /const finalParts = completedAssistantParts\[finalAssistantIdx\]/);
  assert.match(source, /writtenFiles: writtenFilesByAssistantIndex\.get\(finalAssistantIdx\)/);
});

test("mounts the minimap for every visible chat pane", () => {
  assert.match(source, /!isVisiblePane \|\| isMobile \|\| pendingScrollRestore \? null/);
  assert.doesNotMatch(source, /!isFocusedPane \|\| isMobile \|\| pendingScrollRestore/);
});

test("keeps process indicator active before answer and drops trailing pulse under streaming answer", () => {
  assert.match(
    source,
    /function isLiveProcessActivity\([\s\S]*?hasAnswer = false[\s\S]*?return !hasAnswer;/,
  );
  assert.match(
    source,
    /\{streamState\.isStreaming && streamingParts\.answerMessage && \(\s*<MessageView message=\{streamingParts\.answerMessage\}[^>]*\/>\s*\)\}/,
  );
});

test("resets unmounted window and jumps to latest turn when sending a prompt", () => {
  assert.match(
    source,
    /const handleChatSend = useCallback\(async[\s\S]*?setUnmountedNewerCount\(0\);[\s\S]*?setMountLimit\(MOUNTED_GROUP_LIMIT\);[\s\S]*?await handleSend\(message, images\);[\s\S]*?scrollUserMsgToTop\(\)/,
  );
  assert.match(source, /<ChatInput[\s\S]*?onSend=\{handleChatSend\}/);
});

test("removes the bottom extension status shelf from the chat window", () => {
  assert.doesNotMatch(source, /<ExtensionStatusBar/);
  assert.doesNotMatch(source, /import\s*\{\s*ExtensionStatusBar\s*\}\s*from/);
});

test("omits error from partitioned process message to avoid duplicate terminal error card", () => {
  assert.match(source, /omitError:\s*Boolean\(answerMessage\)/);
  assert.match(source, /if\s*\(options\.omitError\)\s*\{\s*if\s*\(next\.stopReason === "error"\)\s*next\.stopReason = "stop";\s*next\.errorMessage = undefined;\s*\}/);
});

test("matches process detail text paragraph font size to 11px to align with step items", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(
    css,
    /\.process-details-list \[data-message-text\] \.markdown-body \{\s*font-size: 11px !important;/,
  );
  assert.doesNotMatch(
    css,
    /\.process-details-list \[data-message-text\] \.markdown-body \{\s*font-size: calc\(11\.5px/,
  );
});
