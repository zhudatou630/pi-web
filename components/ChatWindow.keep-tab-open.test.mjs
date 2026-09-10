import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("ChatWindow.tsx", readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "ChatWindow");
assert.ok(component?.body);
const callbackNames = [
  "keepTabOpen", "handleChatFork", "handleChatSend", "handleSteerWithSubmit",
  "handleFollowUpWithSubmit", "handlePromptWithStreamingBehaviorWithSubmit",
];
const declarations = callbackNames.map((name) => {
  const declaration = component.body.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((node) => node.name.getText(source) === name);
  assert.ok(declaration?.initializer, `Missing callback: ${name}`);
  return `const ${declaration.getText(source)};`;
});
function compile(text) {
  return new Script(ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);
}
const callbacksScript = compile(`(() => { ${declarations.join("\n")} return { ${callbackNames.join(", ")} }; })()`);

// Only model useCallback's dependency comparison. Each render has a fresh VM
// scope so a missing dependency really does retain the previous render's closure.
function callbackRenderer() {
  const slots = [];
  return (bindings) => {
    let index = 0;
    return callbacksScript.runInNewContext({
      ...bindings,
      useCallback(callback, deps) {
        const previous = slots[index];
        if (!previous || deps.length !== previous.deps.length || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
          slots[index] = { callback, deps };
        }
        return slots[index++].callback;
      },
    });
  };
}

function bindingsFor(events, overrides = {}) {
  return {
    sessionRef: { current: { id: "own-tab" } },
    session: { id: "stale-render" },
    selectedSession: { id: "globally-selected-tab" },
    sessionIdRef: { current: "other-runtime-id" },
    onKeepTabOpen: (id) => events.push(["keep", id]),
    handleFork() {}, handleSend() {}, handleSteer() {}, handleFollowUp() {},
    handlePromptWithStreamingBehavior() {}, scrollUserMsgToTop() {},
    hasSeenTurnOutputRef: { current: true },
    outlineJumpControllerRef: { current: null },
    setPendingOutlineJump() {}, setPendingSearchScroll() {},
    setUnmountedNewerCount() {}, setMountLimit() {}, MOUNTED_GROUP_LIMIT: 80,
    requestAnimationFrame(callback) { callback(); },
    ...overrides,
  };
}

test("keepTabOpen reads its own tab ref on every call, including identity replacement and draft transitions", () => {
  const events = [];
  const bindings = bindingsFor(events);
  const { keepTabOpen } = callbackRenderer()(bindings);
  keepTabOpen();
  bindings.selectedSession = { id: "another-global-selection" };
  keepTabOpen();
  bindings.sessionRef.current = { id: "replacement-tab" };
  keepTabOpen();
  bindings.sessionRef.current = null;
  keepTabOpen();
  bindings.sessionRef.current = { id: "created-from-draft" };
  keepTabOpen();
  assert.deepEqual(events, [
    ["keep", "own-tab"], ["keep", "own-tab"],
    ["keep", "replacement-tab"], ["keep", "created-from-draft"],
  ]);
});

for (const hasCallback of [true, false]) {
  for (const session of [{ id: "own-tab" }, null]) {
    test(`fork preserves entry and promise (callback=${hasCallback}, draft=${session === null})`, async () => {
      const events = [];
      const promise = Promise.resolve("forked-session");
      const { handleChatFork } = callbackRenderer()(bindingsFor(events, {
        sessionRef: { current: session },
        onKeepTabOpen: hasCallback ? (id) => events.push(["keep", id]) : undefined,
        handleFork(entryId) { events.push(["fork", entryId]); return promise; },
      }));
      const result = handleChatFork("original-entry-id");
      assert.equal(result, promise);
      assert.deepEqual(events, [
        ...(hasCallback && session ? [["keep", "own-tab"]] : []),
        ["fork", "original-entry-id"],
      ]);
      assert.equal(await result, "forked-session");
    });
  }
}

test("fork forwards failure through the original promise after keeping the source tab", async () => {
  const events = [];
  const error = new Error("fork failed");
  const promise = Promise.reject(error);
  const { handleChatFork } = callbackRenderer()(bindingsFor(events, {
    handleFork(entryId) { events.push(["fork", entryId]); return promise; },
  }));
  const result = handleChatFork("failed-entry");
  assert.equal(result, promise);
  await assert.rejects(result, (actual) => actual === error);
  assert.deepEqual(events, [["keep", "own-tab"], ["fork", "failed-entry"]]);
});

const images = [{ data: "aW1hZ2U=", mimeType: "image/png" }];
const entrances = [
  ["handleChatFork", "handleFork", ["entry-id"]],
  ["handleChatSend", "handleSend", ["ordinary message", images]],
  ["handleSteerWithSubmit", "handleSteer", ["steer message", images]],
  ["handleFollowUpWithSubmit", "handleFollowUp", ["follow-up message", images]],
  ["handlePromptWithStreamingBehaviorWithSubmit", "handlePromptWithStreamingBehavior", ["streaming steer", "steer", images]],
  ["handlePromptWithStreamingBehaviorWithSubmit", "handlePromptWithStreamingBehavior", ["streaming follow-up", "followUp", images]],
];
for (const [name, delegate, args] of entrances) {
  test(`${name} ${args[0]} keeps first, forwards arguments, and follows callback dependency changes`, async () => {
    const events = [];
    const promise = Promise.resolve("accepted");
    const bindings = bindingsFor(events, {
      [delegate](...received) {
        assert.deepEqual(received, args);
        received.forEach((value, i) => assert.equal(value, args[i]));
        events.push(["work", delegate]);
        return promise;
      },
    });
    const render = callbackRenderer();
    const first = render(bindings);
    const unchanged = render(bindings);
    assert.equal(unchanged[name], first[name]);
    const firstResult = first[name](...args);
    if (name !== "handleChatSend") assert.equal(firstResult, promise);
    await firstResult;
    assert.deepEqual(events, [["keep", "own-tab"], ["work", delegate]]);

    events.length = 0;
    const updated = render({ ...bindings, onKeepTabOpen: (id) => events.push(["new-keep", id]) });
    await updated[name](...args);
    assert.deepEqual(events, [["new-keep", "own-tab"], ["work", delegate]]);

    events.length = 0;
    const withoutCallback = render({ ...bindings, onKeepTabOpen: undefined });
    await withoutCallback[name](...args);
    assert.deepEqual(events, [["work", delegate]]);
  });
}

test("ordinary send keeps immediately and waits for sending before scheduling scroll", async () => {
  const events = [];
  let finishSend;
  const pendingSend = new Promise((resolve) => { finishSend = resolve; });
  const frames = [];
  const bindings = bindingsFor(events, {
    handleSend(message, attached) {
      assert.equal(message, "send me");
      assert.equal(attached, images);
      events.push(["send"]);
      return pendingSend;
    },
    requestAnimationFrame(callback) { frames.push(callback); },
    scrollUserMsgToTop() { events.push(["scroll"]); },
  });
  const result = callbackRenderer()(bindings).handleChatSend("send me", images);
  assert.deepEqual(events, [["keep", "own-tab"], ["send"]]);
  assert.equal(bindings.hasSeenTurnOutputRef.current, false);
  assert.equal(frames.length, 0);
  finishSend();
  await result;
  assert.equal(frames.length, 1);
  frames[0]();
  assert.deepEqual(events, [["keep", "own-tab"], ["send"], ["scroll"]]);
});

// Locate the actual initial-prompt effect by its dependency, then execute it.
const initialPromptEffect = component.body.statements
  .filter(ts.isExpressionStatement)
  .map((statement) => statement.expression)
  .find((node) => ts.isCallExpression(node) && node.expression.getText(source) === "useEffect"
    && ts.isArrayLiteralExpression(node.arguments[1])
    && node.arguments[1].elements.some((dep) => ts.isIdentifier(dep) && dep.text === "initialPrompt"));
assert.ok(initialPromptEffect, "Missing initial prompt effect");
const initialPromptScript = compile(`(${initialPromptEffect.arguments[0].getText(source)})`);

test("initial prompt keeps the owning tab before automatic send, once and only when ready", () => {
  const events = [];
  const bindings = bindingsFor(events, {
    initialPrompt: "quoted question", initialPromptSentRef: { current: false },
    loading: false, error: null,
    onInitialPromptConsumed: (id) => events.push(["consumed", id]),
    handleSend: (message) => events.push(["send", message]),
  });
  const { keepTabOpen } = callbackRenderer()(bindings);
  const runEffect = (overrides = {}) => initialPromptScript.runInNewContext({ ...bindings, keepTabOpen, ...overrides })();
  runEffect({ loading: true });
  runEffect({ error: "load failed" });
  runEffect({ initialPrompt: "" });
  runEffect({ sessionIdRef: { current: null }, session: null });
  assert.deepEqual(events, []);
  assert.equal(bindings.initialPromptSentRef.current, false);
  runEffect();
  runEffect();
  assert.deepEqual(events, [
    ["consumed", "other-runtime-id"], ["keep", "own-tab"], ["send", "quoted question"],
  ]);
});
