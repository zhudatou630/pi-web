import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

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
  assert.match(source, /const hasBoundary = isMessageGroupBoundary\(messages\[idx\]\)/);
  assert.match(source, /const hasAnchor = isMessageGroupAnchor\(messages\[idx\]\)/);
  assert.match(source, /const boundaryIdx = hasBoundary \? idx : -1/);
  assert.match(source, /if \(hasAnchor\) \{\s*markOutlineTarget\(\[entryIds\[boundaryIdx\]\]\);\s*rendered\.push\(renderMessage\(boundaryIdx\)\);\s*\}/);
  assert.doesNotMatch(
    source,
    /if \(!isMessageGroupAnchor\(msg\)\) \{\s*rendered\.push\(renderMessage\(idx\)\)/,
  );
});

test("skips custom messages without display in the chat and in process details (#1043)", () => {
  assert.match(source, /const msg = options\.messageOverride \?\? messages\[idx\];\s*if \(isHiddenCustomMessage\(msg\)\) return null;/);
  assert.match(
    source,
    /if \(processMessage\.role === "custom"\) \{[^}]*?if \(isHiddenCustomMessage\(processMessage\)\) continue;/,
  );
});

test("starts a stable process group at each subagent notification boundary", () => {
  assert.match(source, /const hasBoundary = isMessageGroupBoundary\(messages\[idx\]\)/);
  assert.match(source, /const notificationStartsProcess = boundaryIdx >= 0 && isSubagentNotificationMessage\(messages\[boundaryIdx\]\)/);
  assert.match(source, /finalAssistantIdx === -1 && !notificationStartsProcess/);
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
  assert.match(source, /if \(lastBlock\?\.type === "toolCall"\) \{/);
  assert.match(source, /imageStepLabel\(lastBlock\.toolName, lastBlock\.input, t\)/);
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
  assert.match(source, /const \{ writtenFilesByAssistantIndex, routinesByAssistantIndex, turnActivityByAssistantIndex \} = useMemo/);
  assert.match(source, /durationSeconds=\{finalAnswerMessage \|\| answeringLive \? undefined : processDurationSeconds\}/);
  assert.match(source, /const finalParts = completedAssistantParts\[finalAssistantIdx\]/);
  assert.match(source, /writtenFiles: writtenFilesByAssistantIndex\.get\(finalAssistantIdx\)/);
});

test("partitions every assistant in a turn so promoted process text can render outside steps", () => {
  assert.match(source, /const parts = completedAssistantParts\[processIdx\]/);
  assert.match(source, /promotedAnswers\.push\(\{ idx: processIdx, message: parts\.answerMessage \}\)/);
  assert.match(source, /keyPrefix: "promoted"/);
  assert.doesNotMatch(source, /processIdx === finalAssistantIdx\s*\?[\s\S]*?: processMessage/);
});

test("does not treat promoted process text as the turn's final answer", () => {
  assert.match(source, /function hasFinalAssistantAnswer[\s\S]*?return hasTrailingFinalAnswer/);
  assert.doesNotMatch(
    source,
    /function hasFinalAssistantAnswer[\s\S]*?splitFinalAssistantBlocks\([\s\S]*?\)\.answerBlocks/,
  );
});

test("renders completed image tool results outside process details", () => {
  assert.match(source, /imageMessage\.role !== "toolResult"[\s\S]*?getImageGenerationResult\(imageMessage\.details\)/);
  assert.match(source, /rendered\.push\(renderMessage\(imageIdx\)\)/);
  assert.match(source, /const view = imageResult \? \([\s\S]*?<GeneratedImageResult/);
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
    /const handleChatSend = useCallback\(async[\s\S]*?setUnmountedNewerCount\(0\);[\s\S]*?setMountLimit\(MOUNTED_GROUP_LIMIT\);[\s\S]*?await handleSend\(message, images\);[\s\S]*?\}, \[handleSend, keepTabOpen\]\)/,
  );
  assert.match(source, /<ChatInput[\s\S]*?onSend=\{handleChatSend\}/);
});

test("removes the bottom extension status shelf from the chat window", () => {
  assert.doesNotMatch(source, /<ExtensionStatusBar/);
  assert.doesNotMatch(source, /import\s*\{\s*ExtensionStatusBar\s*\}\s*from/);
});

test("expanded step bodies stay flat inside the process list", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\[data-step-card\]:hover:not\(:has\(\[aria-expanded="true"\]\)\)/);
  assert.match(css, /\[aria-expanded="true"\]\) > :first-child::before[\s\S]*?inset: 0 -8px;/);
  assert.match(css, /:is\(\.process-details-list, \.step-flat\) \.step-body \{\s*border-top: none;\s*background: transparent;/);
});

test("step rows are styled by CSS, so the process list needs no !important", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const steps = css.slice(css.indexOf("/* Step cards:"), css.indexOf(".answer-copy-button {"));
  assert.ok(steps.length > 1000);
  assert.doesNotMatch(steps, /!important/);
  const view = await readFile(new URL("./MessageView.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(view, /data-step-card=""\s+style=/);
});

test("matches process detail text paragraph font size to 11px to align with step items", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(
    css,
    /\.process-details-list \[data-message-text\] \.markdown-body \{\s*font-size: 11px;/,
  );
  assert.doesNotMatch(
    css,
    /\.process-details-list \[data-message-text\] \.markdown-body \{\s*font-size: calc\(11\.5px/,
  );
});

test("keeps one process group identity from streaming into the persisted assistant", async () => {
  assert.doesNotMatch(source, /key="streaming-process-group"/);
  const expressions = [...source.matchAll(/key=\{(`process-group-[^`]+`)\}/g)].map((match) => match[1]);
  assert.equal(expressions.length, 2);
  const [streamingKey, persistedKey] = expressions.map((expression) => (
    new Function("messageKeys", "firstIdx", `return ${expression};`)
  ));
  const { carryMessageKeys, messageRenderKeys } = await createJiti(import.meta.url).import("../lib/message-keys.ts");
  for (const entryIds of [[], ["anchor"]]) {
    const firstIdx = entryIds.length;
    const prompt = { role: "user", content: "question", timestamp: 1 };
    const previous = { messages: [...entryIds.map(() => prompt), prompt], entryIds, aliases: new Map() };
    const next = {
      messages: [...previous.messages, { role: "assistant", content: [{ type: "thinking", thinking: "plan" }], timestamp: 2 }],
      entryIds: [...entryIds, "prompt", "assistant"],
    };
    const liveKeys = messageRenderKeys(entryIds, previous.messages.length, previous.aliases);
    const savedKeys = messageRenderKeys(next.entryIds, next.messages.length, carryMessageKeys(previous, next));
    assert.notEqual(liveKeys[firstIdx], next.entryIds[firstIdx], "the prompt acquires a different entry id");
    assert.equal(streamingKey(liveKeys, firstIdx), persistedKey(savedKeys, firstIdx));
  }
});

test("only auto-scrolls process details when the list overflows", () => {
  assert.match(
    source,
    /if \(!box \|\| userScrolledUpRef\.current\) return;\s*if \(box\.scrollHeight <= box\.clientHeight \+ 1\) return;/,
  );
});

test("manual disclosure clicks detach tail follow before content grows", () => {
  assert.match(source, /ref=\{scrollContainerRef\}\s*onClickCapture=\{\(event\) => \{[\s\S]*?closest\('button\[aria-expanded\], summary'\)[\s\S]*?isNearBottomRef\.current = false;/);
  assert.match(source, /userToggledRef\.current = true;\s*userScrolledUpRef\.current = true;\s*setExpanded\(\(v\) => !v\)/);
});

test("compaction file metadata uses UI typography without changing summary prose", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.compaction-file-details \{[^}]*font-family: var\(--font-ui\);[^}]*font-size: 11px;/);
  assert.match(css, /\.compaction-file-list \{[^}]*font-family: var\(--font-ui\);[^}]*font-size: 11px;/);
});

test("disables scroll anchoring on chat container and steps list to prevent jitter", () => {
  assert.match(source, /ref=\{scrollContainerRef\}[\s\S]*?overflowAnchor:\s*"none"/);
  assert.match(source, /ref=\{scrollBoxRef\}[\s\S]*?overflowAnchor:\s*"none"/);
});

test("keeps an unanswered turn's duration beside what it did", () => {
  assert.match(source, /if \(label\) return turnSeconds \? `\$\{label\} · \$\{formatDuration\(turnSeconds, t\)\}` : label;/);
  assert.match(source, /answeringLive \? undefined : processDurationSeconds,/);
});

test("labels a turn that only reasoned as one timed thought", () => {
  assert.match(source, /const thoughtSeconds = activity\.thoughtSeconds \|\| turnSeconds;/);
  assert.match(source, /t\("chat\.activity\.thoughtFor", \{ duration: formatDuration\(thoughtSeconds, t\) \}\)/);
});
