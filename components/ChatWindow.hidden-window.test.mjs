import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const display = await jiti.import("../lib/message-display.ts");
const lazy = await jiti.import("../lib/chat-lazy-load.ts");
const outline = await jiti.import("../lib/chat-outline-jump.ts");
const modelTiming = await jiti.import("../lib/model-timing.ts");
const file = ts.createSourceFile("ChatWindow.tsx", readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(node, predicate) {
  if (predicate(node)) return node;
  return ts.forEachChild(node, (child) => find(child, predicate));
}
// Execute the complete production grouping + mounted-window JSX, not a copied filter.
const renderBody = find(file, (node) => ts.isArrowFunction(node) && ts.isBlock(node.body)
  && node.body.statements.some((statement) => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some((declaration) => declaration.name.getText(file) === "rendered")));
assert.ok(renderBody);
const helpers = ["hasFinalAssistantAnswer", "findFinalAssistantIndex", "elapsedProcessSeconds", "isLiveProcessActivity", "lastStreamingBlock", "latchedLiveProcessSummary", "liveProcessSummary", "formatTurnActivity"]
  .map((name) => find(file, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(file)).join("\n");
const code = ts.transpileModule(`${helpers}\nreturn (${renderBody.getText(file)})();`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;

function render(messages, locate = null, overrides = {}) {
  const entryIds = messages.map((_, index) => `entry-${index}`);
  const mountedRangeRef = { current: null };
  const scope = {
    React, ...display, ...lazy, ...outline, ...modelTiming, messages, entryIds, messageKeys: entryIds, mountedRangeRef,
    // Leaf presentation is intentionally simple; grouping and slicing are real.
    groupBoundaries: display.getMessageGroupBoundaries(messages, { openTail: Boolean(overrides.agentRunning || overrides.streamState?.isStreaming) }),
    MessageView: ({ message, turnDurationSeconds }) => React.createElement("p", { "data-duration": turnDurationSeconds }, message.role === "bashExecution" ? `SHELL:${message.command}` : typeof message.content === "string" ? message.content : (message.content ?? []).map((block) => block.text ?? (block.toolName === "ask_user" ? block.input?.question : "") ?? "").join("")),
    ProcessDetailsGroup: ({ children }) => React.createElement("section", null, children),
    getImageGenerationResult: () => null, IMAGE_RESULT_TYPE: "image-result",
    getModelDisplayName: () => "model", modelNames: new Map(),
    messageRefs: { current: [] }, messageCwd: "/project", imageConfig: null, sideChatStartIdx: -1,
    sessionBusy: false, sessionEnded: false, bashRunning: false, directImageRunning: false, liveUserEntryIds: new Map(),
    session: { id: "s1" }, sessionIdRef: { current: "s1" },
    streamState: { isStreaming: false }, streamingParts: {}, streamingAssistant: null,
    completedAssistantParts: messages.map((message) => message.role === "assistant" ? display.partitionAssistantMessage(message) : null),
    writtenFilesByAssistantIndex: new Map(), routinesByAssistantIndex: new Map(), turnActivityByAssistantIndex: new Map(),
    toolResultsMap: new Map(), toolClocks: new Map(), agentPhase: null,
    questionState: { answers: new Map(), activeQuestionId: null, cardAnswerIndexes: new Set() }, handleChatSend() {},
    liveProcessSummaryRef: { current: null }, isCompacting: false, isMobile: false,
    pendingOutlineJump: locate ? { entryId: locate, signal: { aborted: false } } : null,
    pendingSearchScroll: null, pendingScrollRestore: null, searchTarget: null,
    editEntryId: null, isNew: false, forkingEntryId: null, continuePrompt: null,
    recoverTruncation: false, compactError: null, openFileFromSession() {}, onOpenSession() {},
    handleChatFork() {}, handleEditContent() {}, cancelEdit() {}, handleContinue() {}, handleCompact() {},
    mountLimit: lazy.MOUNTED_GROUP_LIMIT, unmountedNewerCount: 0, hasEarlierMessages: false,
    sentinelRef: { current: null }, newerSentinelRef: { current: null }, triggerLoadEarlier() {},
    t: (key) => key, formatDuration: () => "", displayToolName: (name) => name,
    ...overrides,
  };
  const element = new Function(...Object.keys(scope), code)(...Object.values(scope));
  return { html: renderToStaticMarkup(element), range: mountedRangeRef.current, entryIds };
}
const hidden = () => ({ role: "custom", customType: "internal", display: false, content: "HIDDEN" });
const user = { role: "user", content: "QUESTION" };
const answer = { role: "assistant", content: [{ type: "text", text: "ANSWER" }], stopReason: "stop" };

test("finishing an outline jump during a running turn preserves the mounted window", () => {
  const messages = [
    ...Array.from({ length: 60 }, () => [user, answer]).flat(),
    user, ...Array.from({ length: 80 }, hidden),
  ];
  const running = { sessionBusy: true };
  const located = render(messages, "entry-60", running);
  const settled = render(messages, null, {
    ...running,
    unmountedNewerCount: located.range.totalCount - located.range.endIndex,
  });
  assert.deepEqual(settled.range, located.range);
  assert.equal(settled.html, located.html);
  assert.equal(settled.range.endIndex - settled.range.startIndex, lazy.MOUNTED_GROUP_LIMIT);
});

test("Q/A plus 60 hidden tail messages keeps the real answer in final mounted output", () => {
  const messages = [user, answer, ...Array.from({ length: 60 }, hidden)];
  const { html, range, entryIds } = render(messages);
  assert.match(html, /QUESTION/);
  assert.match(html, /ANSWER/);
  assert.match(html, /data-entry-id="entry-1"/);
  assert.doesNotMatch(html, /HIDDEN|chat.loadEarlier/);
  assert.deepEqual(range, { startIndex: 0, endIndex: 2, totalCount: 2 });
  assert.equal(messages.length, 62);
  assert.equal(entryIds.length, 62);
});

test("ask_user and preceding text stay outside the collapsed process group", () => {
  const message = { role: "assistant", content: [
    { type: "toolCall", toolCallId: "bash", toolName: "bash", input: { command: "pwd" } },
    { type: "text", text: "CLARIFICATION" },
    { type: "toolCall", toolCallId: "question", toolName: "ask_user", input: { question: "WHICH OPTION?" } },
  ] };
  const { html } = render([user, message, { role: "toolResult", toolCallId: "question", content: [] }]);
  assert.match(html, /CLARIFICATIONWHICH OPTION\?/);
  assert.doesNotMatch(html.match(/<section>[\s\S]*?<\/section>/)?.[0] ?? "", /CLARIFICATION|WHICH OPTION/);
  assert.match(html, /<\/section>[\s\S]*CLARIFICATIONWHICH OPTION\?/);
});

test("extension completion and shell cards stay between the old answer and the new process fold", () => {
  const oldAnswer = { ...answer, timestamp: 1000, completedAt: 2000 };
  const completion = { role: "custom", customType: "completion", display: true, content: "COMPLETION", timestamp: 3000 };
  const wakeup = { ...hidden(), timestamp: 3_603_000 };
  const shell = { role: "bashExecution", command: "pwd", output: "/tmp", timestamp: 4000 };
  const newAnswer = { ...answer, content: [{ type: "thinking", thinking: "work" }, { type: "text", text: "NEW ANSWER" }], timestamp: 3_604_000, completedAt: 3_605_000 };
  for (const stretch of [[completion, shell, wakeup], [shell, completion, wakeup], [completion, wakeup, shell]]) {
    const { html } = render([user, oldAnswer, ...stretch, newAnswer]);
    assert.match(html, /ANSWER[\s\S]*COMPLETION[\s\S]*<section>/);
    assert.match(html, /ANSWER[\s\S]*SHELL:pwd[\s\S]*<section>/);
    assert.match(html, /<\/section>[\s\S]*data-duration="2"[^>]*>NEW ANSWER/);
    assert.doesNotMatch(html.match(/<section>[\s\S]*?<\/section>/)?.[0] ?? "", /COMPLETION|SHELL|NEW ANSWER/);
    assert.doesNotMatch(html, /HIDDEN/);
  }
});

test("hidden-only wakeups have no visible row or ref and open their own streaming process", () => {
  const messages = [user, answer, hidden()];
  const liveMessage = { role: "assistant", content: [{ type: "thinking", thinking: "work" }], timestamp: 5000 };
  const { html, range } = render(messages, null, {
    agentRunning: true, sessionBusy: true, streamState: { isStreaming: true }, streamingAssistant: liveMessage,
    streamingParts: display.partitionAssistantMessage(liveMessage, { isStreaming: true }),
  });
  assert.match(html, /ANSWER[\s\S]*<section>/);
  assert.doesNotMatch(html, /HIDDEN|data-entry-id="entry-2"/);
  assert.deepEqual(range, { startIndex: 0, endIndex: 3, totalCount: 3 });
});

test("ordinary no-answer turns skip hidden slots and preserve ids and locate-window bookkeeping", () => {
  const messages = [...Array.from({ length: 60 }, hidden), user, ...Array.from({ length: 60 }, hidden)];
  const { html, range } = render(messages, "entry-60");
  assert.match(html, /QUESTION/);
  assert.match(html, /data-entry-id="entry-60"/);
  assert.doesNotMatch(html, /HIDDEN|chat.loadEarlier/);
  assert.deepEqual(range, { startIndex: 0, endIndex: 1, totalCount: 1 });
});
