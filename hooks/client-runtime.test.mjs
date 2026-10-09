import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
function evaluate(code, bindings, result = "") {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), `${js}\n${result}`)(...Object.values(bindings));
}
const noop = () => {};
const ref = (current) => ({ current });
const useCallback = (fn) => fn;

function uiHarness() {
  let dialogs = [];
  let panels = [];
  const bindings = {
    useCallback, isBlockingExtensionUiRequest: () => false, addNotice: noop,
    onAttentionNeeded: noop, opts: {},
    setExtensionDialogs: (update) => { dialogs = update(dialogs); },
    setExtensionCustomUis: (update) => { panels = update(panels); },
    sessionIdRef: ref("session"), loadSession: noop, dispatch: noop,
    cancelEventStreamGrace: noop, sdkAgentActiveRef: ref(false), rpcPromptPendingRef: ref(false),
    agentRunningRef: ref(false), setAgentRunning: noop, setAgentPhase: noop, handshakePhase: noop,
    promptRunIdRef: ref(0),
  };
  const request = evaluate(between("  const handleExtensionUiRequest", "  const flushStreamDeltas"), bindings, "return handleExtensionUiRequest;");
  const event = (event) => evaluate(`switch (event.type) { ${between('      case "connected":', '      case "agent_start":')} ${between('      case "extension_ui_closed":', '\n    }\n  }, [addNotice, applyContextUsage')} }`, { ...bindings, event });
  return { request, event, bindings, dialogs: () => dialogs, panels: () => panels };
}

test("custom panels queue by id, update in place, and closing any id removes only that request", () => {
  const ui = uiHarness();
  const first = { method: "custom", id: "a", lines: ["first"] };
  const second = { method: "custom", id: "b", lines: ["second"] };
  ui.request(first);
  ui.request(second);
  const update = { ...second, lines: ["updated"] };
  ui.request(update);
  assert.deepEqual(ui.panels(), [first, update]);
  ui.request({ ...second, closed: true });
  assert.deepEqual(ui.panels(), [first]);
  ui.event({ type: "extension_ui_closed", id: "a" });
  assert.deepEqual(ui.panels(), []);
});

test("reconnect drops closed requests but retains live dialog objects and FIFO order on replay", () => {
  const ui = uiHarness();
  const stale = { method: "input", id: "stale" };
  const live = { method: "input", id: "live", prefill: "original" };
  ui.request(stale);
  ui.request(live);
  ui.request({ method: "custom", id: "stale-panel" });
  ui.request({ method: "custom", id: "live-panel" });
  ui.event({ type: "connected", isStreaming: false, pendingExtensionUiIds: ["live", "live-panel"] });
  assert.equal(ui.dialogs()[0], live);
  ui.request({ ...live, prefill: "must not reset input" });
  assert.equal(ui.dialogs()[0], live);
  assert.equal(ui.dialogs().length, 1);
  assert.deepEqual(ui.panels().map((panel) => panel.id), ["live-panel"]);
  ui.event({ type: "connected", isStreaming: false }); // Older server: leave live requests alone.
  assert.equal(ui.dialogs()[0], live);
  ui.event({ type: "connected", isStreaming: false, pendingExtensionUiIds: [] });
  assert.deepEqual(ui.dialogs(), []);
  assert.deepEqual(ui.panels(), []);
});

test("both navigation callers block busy sessions and only switch after successful navigation", async () => {
  const calls = [];
  let result = {};
  const bindings = {
    useCallback, bashRunningRef: ref(false), agentRunningRef: ref(false), sessionRunningRef: ref(false),
    isCompacting: false, sessionIdRef: ref("session"), sessionHookMountedRef: ref(true),
    sendAgentCommand: async () => { calls.push("navigate"); if (result instanceof Error) throw result; return result; },
    setActiveLeafId: (id) => calls.push(["leaf", id]), loadContext: async () => { calls.push("context"); },
    addNotice: () => calls.push("error"),
  };
  const code = between("  const handleLeafChange", "  const handleModelChange");
  const make = () => evaluate(code, bindings, "return [handleLeafChange, handleNavigate];");
  for (const flag of ["bashRunningRef", "agentRunningRef", "sessionRunningRef", "isCompacting"]) {
    if (flag === "isCompacting") bindings[flag] = true;
    else bindings[flag].current = true;
    for (const navigate of make()) await navigate("leaf");
    assert.deepEqual(calls, []);
    if (flag === "isCompacting") bindings[flag] = false;
    else bindings[flag].current = false;
  }
  const [navigate, alias] = make();
  assert.equal(navigate, alias);
  for (const outcome of [new Error("server refused"), { cancelled: true }, { aborted: true }]) {
    result = outcome;
    await navigate("leaf");
    assert.ok(!calls.includes("context"));
    assert.ok(!calls.some(Array.isArray));
    calls.length = 0;
  }
  result = {};
  await navigate("leaf");
  assert.deepEqual(calls, ["navigate", ["leaf", "leaf"], "context"]);
});

test("context usage fences applied replies, not failed newer requests, and checks session/run/mount", () => {
  const values = [];
  const bindings = {
    useCallback, sessionHookMountedRef: ref(true), sessionIdRef: ref("session"), promptRunIdRef: ref(1),
    contextUsageAppliedIdRef: ref(0), keepContextUsage: (_prev, next) => next,
    setContextUsage: (update) => values.push(update(null)),
  };
  const apply = evaluate(between("  const applyContextUsage", "  const loadSession"), bindings, "return applyContextUsage;");
  apply(undefined, "session", 1, 2); // Newer non-usage/failed reply must not fence a good older one.
  apply({ tokens: 10 }, "session", 1, 1);
  apply({ tokens: 30 }, "session", 1, 3);
  apply({ tokens: 20 }, "session", 1, 2);
  apply({ tokens: 40 }, "other-session", 1, 4);
  apply({ tokens: 50 }, "session", 0, 5);
  bindings.sessionHookMountedRef.current = false;
  apply({ tokens: 60 }, "session", 1, 6);
  bindings.sessionHookMountedRef.current = true;
  bindings.contextUsageAppliedIdRef.current = 6; // mount invalidates all earlier reads
  apply({ tokens: 60 }, "session", 1, 6);
  assert.deepEqual(values, [{ tokens: 10 }, { tokens: 30 }]);
  assert.match(source, /contextUsageAppliedIdRef\.current = \+\+contextUsageRequestIdRef\.current/);
  const messageEnd = between('      case "message_end":', '      case "tool_execution_start":');
  assert.doesNotMatch(messageEnd, /fetch\(/, "assistant usage must not add GET requests");
});

test("SSE run starts fence external runs without changing the local prompt's run id", () => {
  const ui = uiHarness();
  const code = `switch ("agent_start") { ${between('      case "agent_start":', '      case "agent_end":')} }`;
  ui.bindings.rpcPromptPendingRef.current = true;
  evaluate(code, ui.bindings);
  assert.equal(ui.bindings.promptRunIdRef.current, 0);
  ui.bindings.rpcPromptPendingRef.current = false;
  evaluate(code, ui.bindings);
  assert.equal(ui.bindings.promptRunIdRef.current, 1);
  ui.bindings.sdkAgentActiveRef.current = false;
  ui.event({ type: "connected", isStreaming: true });
  assert.equal(ui.bindings.promptRunIdRef.current, 2);
  ui.event({ type: "connected", isStreaming: true });
  assert.equal(ui.bindings.promptRunIdRef.current, 2, "reconnect to the same active run is not a new run");
});

test("agent_end ignores late state reads across run/session/unmount/remount boundaries", async () => {
  const code = between('      case "agent_end":', '      case "agent_settled":');
  for (const stale of ["run", "session", "unmount", "remount", "http"]) {
    let finish;
    const writes = [];
    const bindings = {
      agentRunningRef: ref(true), setAgentPhase: noop, setRetryInfo: noop, dispatch: noop,
      sessionIdRef: ref("session"), promptRunIdRef: ref(1), contextUsageRequestIdRef: ref(0),
      sessionHookMountIdRef: ref(1), sessionHookMountedRef: ref(true), loadSession: noop,
      fetch: () => new Promise((resolve) => { finish = resolve; }),
      applyContextUsage: () => writes.push("usage"), setSystemPrompt: () => writes.push("prompt"),
      setQueuedMessages: () => writes.push("queue"), normalizeQueuedMessages: noop,
    };
    evaluate(`switch ("agent_end") { ${code} }`, bindings);
    if (stale === "run") bindings.promptRunIdRef.current++;
    if (stale === "session") bindings.sessionIdRef.current = "other";
    if (stale === "unmount") bindings.sessionHookMountedRef.current = false;
    if (stale === "remount") bindings.sessionHookMountIdRef.current++;
    finish({ ok: stale !== "http", json: async () => ({ state: { contextUsage: {}, systemPrompt: "old" } }) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(writes, [], stale);
  }
});
