import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { MessageView, getWrittenFileText, hasAssistantAnswer } = await jiti.import("./MessageView.tsx");
const { ChatInput, replaceTextareaRange } = await jiti.import("./ChatInput.tsx");
const windowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const viewSource = await readFile(new URL("./MessageView.tsx", import.meta.url), "utf8");
const inputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const render = (component, props) => renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(component, props)));
const assistant = (content) => ({ role: "assistant", content, stopReason: "length" });

function helper(name) {
  const source = ts.createSourceFile("ChatWindow.tsx", windowSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function find(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) return node;
    return ts.forEachChild(node, find);
  }
  const code = ts.transpileModule(find(source).getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return (context = {}) => new Script(`${code}; ${name}`).runInNewContext(context);
}

test("user bubbles keep typed CR, soft and hard breaks, including tight lists; assistants stay unchanged", () => {
  for (const text of ["a\nb", "a\rb", "a\r\nb", "a  \nb", "a\\\nb"]) {
    const html = render(MessageView, { message: { role: "user", content: text } });
    assert.match(html, /<p>a<br\/>b<\/p>/);
    assert.doesNotMatch(html, /<br\/>\n/);
  }
  assert.match(render(MessageView, { message: { role: "user", content: "1. question\nA. option\nB. option" } }), /question<br\/>A\. option<br\/>B\. option/);
  assert.match(render(MessageView, { message: { role: "assistant", content: [{ type: "text", text: "a\nb" }] } }), /<p>a\nb<\/p>/);
  const hinted = render(MessageView, { message: { role: "user", content: "a\rb\r[Image converted from image/webp to image/png.]" } });
  assert.match(hinted, /a<br\/>b/);
  assert.doesNotMatch(hinted, /converted from/);
});

test("thinking-only truncation offers compaction, partial answers keep Continue", () => {
  const recovery = { onCompact() {}, onContinue() {}, continuePrompt: "continue" };
  for (const content of [[], [{ type: "thinking", thinking: "" }], [{ type: "thinking", thinking: "long reasoning" }], [{ type: "text", text: "   " }]]) {
    const message = assistant(content);
    assert.equal(hasAssistantAnswer(message), false);
    const html = render(MessageView, { message, ...recovery });
    assert.match(html, /thinking or a nearly full context/);
    assert.match(html, /Compact context/);
    assert.doesNotMatch(html, /class="turn-continue"/);
  }
  for (const block of [{ type: "text", text: "partial" }, { type: "image", data: "YWJj", mimeType: "image/png" }, { type: "toolCall", toolCallId: "call", toolName: "read", input: {} }]) {
    const message = assistant([block]);
    assert.equal(hasAssistantAnswer(message), true);
    const html = render(MessageView, { message, ...recovery });
    assert.match(html, /class="turn-continue"/);
    assert.doesNotMatch(html, /nearly full context/);
  }
  assert.doesNotMatch(render(MessageView, { message: assistant([]), isStreaming: true, ...recovery }), /Compact context/);
  assert.match(render(MessageView, { message: assistant([]), isCompacting: true, compactError: "compact failed", ...recovery }), /disabled=""/);
  assert.match(windowSource, /lastMessage\.stopReason === "length" && hasAssistantAnswer\(lastMessage\)/);
  assert.match(windowSource, /onCompact=\{idx === messages.length - 1 && recoverTruncation \? handleCompact : undefined\}/);
  assert.match(windowSource, /blocks.length === 0 && !hasError && message.stopReason !== "length"/);
  assert.match(windowSource, /parts\?\.processMessage\s*\?\? \(processMessage.stopReason === "length" && !parts\?\.answerMessage \? processMessage : null\)/);
});

test("only complete, content-only write arguments get the readable text view", () => {
  const block = { type: "toolCall", toolCallId: "write", toolName: "write", input: { path: "a.txt", content: "one\ntwo" } };
  assert.equal(getWrittenFileText(block), "one\ntwo");
  assert.equal(getWrittenFileText({ ...block, input: { file_path: "a.txt", content: "one\ntwo" } }), "one\ntwo");
  for (const changed of [{ rawInput: "{}" }, { toolName: "edit" }, { input: { ...block.input, mode: "append" } }, { input: { ...block.input, content: "" } }, { input: { ...block.input, content: 1 } }]) {
    assert.equal(getWrittenFileText({ ...block, ...changed }), null);
  }
  assert.match(viewSource, /getWrittenFileText\(block\) \?\? getToolCallInputText\(block\)/);
});

test("compaction overrides stale tool/thinking summaries even when an answer already exists", () => {
  const summary = helper("liveProcessSummary")({ displayToolName: (name) => name, imageStepLabel: () => null, lastStreamingBlock: (message) => message?.content.at(-1) });
  const active = helper("isLiveProcessActivity")({ lastStreamingBlock: (message) => message?.content.at(-1) });
  for (const phase of [null, { kind: "waiting_model" }, { kind: "running_tools", tools: [{ name: "read" }] }]) {
    assert.equal(summary({ content: [{ type: "thinking" }] }, phase, (key) => key, true), "chat.compacting");
    assert.equal(active(true, false, null, phase, true, true), true);
  }
  assert.equal(active(false, false, null, null, true, true), false);
  assert.equal(summary({ content: [{ type: "thinking" }] }, null, (key) => key, false), "chat.thinking");
  const latchedSummary = helper("latchedLiveProcessSummary")();
  const latched = { current: "read" };
  assert.equal(latchedSummary("Compacting", true, latched, "Thinking", "Compacting"), "Compacting");
  assert.equal(latched.current, "read");
  assert.equal(latchedSummary(null, true, latched, "Thinking"), "read");
  assert.match(windowSource, /liveProcessSummary\(streamingAssistant, agentPhase, t, isCompacting\)/);
  assert.match(windowSource, /liveProcessSummary\(streamingParts.processMessage, agentPhase, t, isCompacting\)/);
});

test("long table cells wrap without fixed layout; long dialog titles shrink/scroll above the options", () => {
  const cells = css.match(/\.markdown-body th, \.markdown-body td \{([^}]*)\}/)[1];
  assert.match(cells, /max-width: 32em/);
  assert.match(cells, /overflow-wrap: anywhere/);
  assert.match(css, /\.markdown-table-wrap > table \{ width: max-content; \}/);
  assert.match(css, /\.markdown-table-wrap \{[^}]*overflow-x: auto/);
  assert.doesNotMatch(css, /table-layout: fixed/);
  const header = css.match(/\.extension-dialog-header \{([^}]*)\}/)[1];
  assert.match(header, /min-height: 0/);
  assert.match(header, /flex-shrink: 1/);
  assert.match(header, /overflow-y: auto/);
  assert.match(header, /max-height: min\(30dvh, 180px\)/);
});

test("reasoning control stays enabled during streaming", async () => {
  const html = render(ChatInput, { onSend() {}, onAbort() {}, isStreaming: true, thinkingLevel: "low", onThinkingLevelChange() {} });
  const button = html.match(/<button[^>]*aria-label="Change reasoning level"[^>]*>/)?.[0];
  assert.ok(button, html);
  assert.doesNotMatch(button, /disabled/);
  assert.doesNotMatch(inputSource, /if \(!isStreaming\) return;\s*setThinkingDropdownOpen\(false\)/);
  const server = await readFile(new URL("../lib/rpc-manager.ts", import.meta.url), "utf8");
  const path = server.slice(server.indexOf('case "set_thinking_level":'), server.indexOf('case "compact":'));
  assert.match(path, /this.inner.setThinkingLevel\(level, \{ persist: true \}\)/);
  assert.doesNotMatch(path, /isStreaming|isRunning|Cannot/);
});

test("mentions are native undoable range edits, with a working fallback and quoted cursor", () => {
  const oldDocument = globalThis.document;
  try {
    for (const mode of ["native", "refused", "missing"]) {
      const commands = [];
      const textarea = {
        value: 'before @"di" after', selectionStart: 11, selectionEnd: 11,
        focus() {}, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
        setRangeText(text, start, end) { this.value = this.value.slice(0, start) + text + this.value.slice(end); },
        dispatchEvent(event) { assert.equal(event.type, "input"); },
      };
      globalThis.document = mode === "missing" ? {} : { execCommand(command, _ui, text) {
        commands.push(command);
        if (mode === "refused") return false;
        textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd);
        return true;
      } };
      replaceTextareaRange(textarea, 7, 12, '@"dir/"', 6);
      assert.equal(textarea.value, 'before @"dir/" after');
      assert.equal(textarea.selectionStart, 13);
      if (mode === "native") assert.deepEqual(commands, ["insertText"]);
    }
  } finally {
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  }
  assert.match(inputSource, /replaceTextareaRange\(ta, atQuery.start, replaceEnd, insert.text, insert.cursorOffset\)/);
  assert.match(inputSource, /replaceTextareaRange\(ta, start, end, sep \+ text\)/);
});

test("list continuation listens only to cancellable non-IME native newline edits and shares undo", () => {
  assert.match(inputSource, /event.inputType !== "insertLineBreak" \|\| !event.cancelable \|\| event.isComposing \|\| isComposingRef.current/);
  assert.match(inputSource, /replaceTextareaRange\(ta, edit.start, edit.end, edit.text\)/);
  assert.match(inputSource, /addEventListener\("beforeinput", continueList\)/);
});
