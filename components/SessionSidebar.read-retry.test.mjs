import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
const { withoutReadMarks } = await createJiti(import.meta.url).import("../lib/unread-state.ts");

const text = readFileSync(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("SessionSidebar.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(node, predicate) {
  if (predicate(node)) return node;
  return ts.forEachChild(node, (child) => find(child, predicate));
}
function execute(code, scope) {
  return new Script(ts.transpileModule(`(${code})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText).runInNewContext(scope);
}
const manualRef = find(ast, (node) => ts.isVariableDeclaration(node) && node.name.getText(ast) === "manualReadIdsRef");
const toggle = find(ast, (node) => ts.isJsxAttribute(node) && node.name.getText(ast) === "onToggleRead");
const effect = find(ast, (node) => ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" && node.arguments[0]?.getText(ast).includes("let stopped = false;"));

for (const missedRunning of [false, true]) {
  test(`manual read retries keep the click-time boundary (${missedRunning ? "running snapshot lost" : "server refused while running"})`, async () => {
    const timers = [];
    const requests = [];
    const sharedReadAt = {};
    let step = 0;
    const scope = {
      AbortController, Set, Map, Math, JSON,
      useRef: (value) => ({ current: value }),
      performance: { now: () => 10 },
      document: { visibilityState: "visible", hasFocus: () => true, addEventListener() {}, removeEventListener() {} },
      hasRecentAttention: () => true, lastInputAtRef: { current: 1 }, visibleReadIdsRef: { current: [] },
      readSnapshotRef: { current: { serverNow: 150, receivedAt: 0, readAt: {}, completedAt: { root: 100 }, pendingIds: new Set() } },
      runningPollAuthoritativeRef: { current: false }, currentSuppressedCompletionSessionIdsRef: { current: new Set() }, sessionListVersionRef: { current: 1 },
      RUNNING_SESSIONS_POLL_MS: 2500, HIDDEN_RUNNING_SESSIONS_POLL_MS: 30000,
      setTimeout: (fn) => { timers.push(fn); return 1; }, clearTimeout() {}, loadSessions() {},
      withoutReadMarks: (marks) => marks, sameIdSet: (current) => current, sameTimes: (current) => current,
      family: { root: { id: "root" } }, familySessions: [{ id: "root" }], unreadMarks: new Map([["root", 100]]),
      markSessionFamilyRead: () => new Set(),
      fetch: async (_url, options) => {
        const body = options.body ? JSON.parse(options.body) : null;
        requests.push(body);
        step += 1;
        if (step === 1 && missedRunning) throw new Error("offline");
        const running = step === 1;
        if (!running && body) for (const id of body.readSessionIds) sharedReadAt[id] = body.observedAt;
        return { ok: true, json: async () => ({ serverNow: 100 + step * 100, sessionListVersion: 1, runningSessionIds: running ? ["root"] : [], completedAt: running ? {} : { root: 300 }, readAt: { ...sharedReadAt } }) };
      },
    };
    scope.manualReadIdsRef = execute(manualRef.initializer.getText(ast), scope);
    for (const name of ["UnreadMarks", "SubagentsActiveSessionIds", "RunningSessionIds", "AwaitingInputSessionIds", "CacheKeepaliveSessions"]) scope[`set${name}`] = () => {};
    execute(toggle.initializer.expression.getText(ast), scope)();
    const cleanup = execute(effect.arguments[0].getText(ast), scope)();
    await setImmediate();
    for (let i = 0; i < 3; i++) { timers.shift()(); await setImmediate(); }
    assert.equal(requests[0].observedAt, 150);
    assert.ok(requests.filter(Boolean).every((request) => request.observedAt === 150), "retries must not borrow a newer poll's time");
    assert.equal(sharedReadAt.root, 150);
    assert.ok(sharedReadAt.root < 300, "the new reply stays unread in every browser");
    assert.equal(scope.manualReadIdsRef.current.size, 0, "acknowledging the old read ends its retry");
    cleanup();
  });
}

test("polls send known read versions and retain omitted reads while adopting updates and explicit deletion", async () => {
  const timers = [], requests = [];
  const initialReads = { root: 200 };
  let marks = new Map([["root", 100]]);
  const responses = [
    { readAtVersion: "v1" },
    { readAtVersion: "v2", readAt: { root: 250 } },
    { readAtVersion: "v2" },
    { readAtVersion: "v3", readAt: {} },
  ];
  const scope = {
    AbortController, Set, Map, Math, JSON, URLSearchParams,
    performance: { now: () => 10 }, document: { visibilityState: "visible", hasFocus: () => true, addEventListener() {}, removeEventListener() {} },
    hasRecentAttention: () => true, lastInputAtRef: { current: 1 }, visibleReadIdsRef: { current: [] }, manualReadIdsRef: { current: new Map() },
    readSnapshotRef: { current: { serverNow: 200, receivedAt: 0, readAtVersion: "v1", readAt: initialReads, completedAt: {}, pendingIds: new Set() } },
    runningPollAuthoritativeRef: { current: false }, currentSuppressedCompletionSessionIdsRef: { current: new Set() }, sessionListVersionRef: { current: 1 },
    RUNNING_SESSIONS_POLL_MS: 2500, HIDDEN_RUNNING_SESSIONS_POLL_MS: 30000,
    setTimeout: (fn) => { timers.push(fn); return 1; }, clearTimeout() {}, loadSessions() {},
    withoutReadMarks, sameIdSet: (current) => current, sameTimes: (current) => current,
    fetch: async (url, options) => {
      requests.push({ url, body: options.body ? JSON.parse(options.body) : null });
      return { ok: true, json: async () => ({ serverNow: 200 + requests.length * 50, sessionListVersion: 1, ...responses.shift() }) };
    },
  };
  for (const name of ["SubagentsActiveSessionIds", "RunningSessionIds", "AwaitingInputSessionIds", "CacheKeepaliveSessions"]) scope[`set${name}`] = () => {};
  scope.setUnreadMarks = (update) => { marks = update(marks); };
  const cleanup = execute(effect.arguments[0].getText(ast), scope)();
  await setImmediate();
  assert.equal(new URL(requests[0].url, "http://localhost").searchParams.get("readAtVersion"), "v1");
  assert.equal(scope.readSnapshotRef.current.readAt, initialReads);
  assert.equal(marks.size, 0, "omission must still clear stale local markers using the known reads");
  scope.visibleReadIdsRef.current = ["root"];
  timers.shift()(); await setImmediate();
  assert.equal(requests[1].body.readAtVersion, "v1");
  assert.equal(scope.readSnapshotRef.current.readAt.root, 250);
  scope.visibleReadIdsRef.current = [];
  timers.shift()(); await setImmediate();
  assert.equal(new URL(requests[2].url, "http://localhost").searchParams.get("readAtVersion"), "v2");
  assert.equal(scope.readSnapshotRef.current.readAt.root, 250);
  marks.set("root", 300);
  timers.shift()(); await setImmediate();
  assert.deepEqual(Object.keys(scope.readSnapshotRef.current.readAt), []);
  assert.equal(marks.get("root"), 300);
  assert.equal(scope.readSnapshotRef.current.readAtVersion, "v3");
  cleanup();
});
