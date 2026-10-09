import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const control = source.slice(
  source.indexOf("function NewSessionCwdControl"),
  source.indexOf("function NewSessionUpdateLink"),
);

test("path menu and worktree menu are separate", () => {
  assert.match(control, /setBranchMenuOpen\(\(open\) => !open\)/);
  assert.match(control, /onClick=\{\(\) => choose\(wt\.path\)\}/);
  assert.match(control, /aria-label=\{t\("sidebar\.switchWorktree"\)\}/);
  const pathMenu = control.slice(control.indexOf("{menuOpen &&"), control.indexOf("{branchMenuOpen &&"));
  assert.doesNotMatch(pathMenu, /worktrees\.map/);
});

test("path menu renders sidebar workspace state; only opening the worktree menu refreshes", () => {
  assert.match(control, /recentPaths: string\[\]/);
  assert.match(control, /pinnedPaths: string\[\]/);
  assert.match(control, /worktreeInfo:/);
  assert.doesNotMatch(control, /\/api\/sessions/);
  assert.doesNotMatch(control, /\/api\/home/);
  assert.match(control, /if \(!branchMenuOpen\) return;/);
  assert.match(control, /\/api\/worktrees\?cwd=/);
});

function find(root, predicate) {
  if (predicate(root)) return root;
  return ts.forEachChild(root, (child) => find(child, predicate));
}
function evaluate(expression, bindings) {
  const js = ts.transpileModule(`return (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}

test("worktree menu refreshes on every open, retaining the last list on failure and ignoring closed-menu replies", async () => {
  const parsed = ts.createSourceFile("ChatWindow.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const effect = find(parsed, (node) => ts.isCallExpression(node) && node.expression.getText(parsed) === "useEffect"
    && node.arguments[0].getText(parsed).includes("/api/worktrees?cwd="));
  assert.equal(effect.arguments[1].getText(parsed), "[branchMenuOpen, cwd]");
  const writes = [];
  const calls = [];
  let response = Response.json({ projectRoot: "/root", currentWorktreePath: "/root/new", worktrees: [{ path: "/root/new", branch: "new" }] });
  const bindings = {
    AbortController, branchMenuOpen: false, cwd: "/root/new",
    fetch: async (url, options) => { calls.push([url, options]); return response; },
    setRefreshedWorktree: (data) => writes.push(data),
  };
  const open = () => evaluate(effect.arguments[0].getText(parsed), bindings)();
  assert.equal(open(), undefined);
  assert.equal(calls.length, 0);
  bindings.branchMenuOpen = true;
  let cleanup = open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[0][0], "/api/worktrees?cwd=%2Froot%2Fnew");
  assert.equal(writes[0].forCwd, "/root/new");
  assert.equal(writes[0].worktrees[0].branch, "new");
  cleanup();
  response = Response.json({ projectRoot: "/root", worktrees: [{ path: "/root/later", branch: "later" }] });
  cleanup = open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(writes[1].worktrees[0].branch, "later");
  cleanup();
  response = Response.json({ error: "offline" }, { status: 503 });
  cleanup = open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 2, "failure keeps the last successful list");
  cleanup();
  const late = Promise.withResolvers();
  bindings.fetch = () => late.promise;
  cleanup = open();
  cleanup(); // Closing or changing cwd aborts the request.
  late.resolve(Response.json({ projectRoot: "/stale", worktrees: [] }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 2);
});

test("draft cwd validation uses stable project identity without rekeying/remounting or changing sibling drafts", async () => {
  const text = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("AppShell.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = find(parsed, (node) => ts.isVariableDeclaration(node) && node.name.getText(parsed) === "handleDraftCwdChange");
  const sameProject = { kind: "draft", id: "tab", newSessionDraftKey: "draft-key", newSessionCwd: "/old", projectKey: "/old" };
  const sibling = { ...sameProject, id: "sibling", newSessionDraftKey: "sibling-key" };
  let tabs = [sameProject, sibling];
  const writes = [];
  let validated = { cwd: "/root/worktree", projectKey: "stable-root-key", projectRoot: "/root" };
  const bindings = {
    fetch: async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body), { cwd: "~/project" });
      return Response.json(validated);
    },
    setChatTabs: (update) => { tabs = update(tabs); },
    activeNewSessionDraftKeyRef: { current: "draft-key" },
    setNewSessionCwd: (cwd) => writes.push(["draft", cwd]), setActiveCwd: (cwd) => writes.push(["active", cwd]),
  };
  const change = evaluate(declaration.initializer.arguments[0].getText(parsed), bindings);
  await change("draft-key", "~/project");
  assert.deepEqual(tabs[0], { ...sameProject, newSessionCwd: "/root/worktree", projectKey: "stable-root-key" });
  assert.equal(tabs[1], sibling);
  assert.deepEqual(writes, [["draft", "/root/worktree"], ["active", "/root/worktree"]]);
  validated = { cwd: "/root/linked", projectRoot: "/root" }; // Root fallback for older replies.
  await change("draft-key", "~/project");
  assert.equal(tabs[0].projectKey, "/root");
  const beforeFailure = tabs;
  bindings.fetch = async () => Response.json({ error: "invalid directory" }, { status: 400 });
  const rejectChange = evaluate(declaration.initializer.arguments[0].getText(parsed), bindings);
  await assert.rejects(rejectChange("draft-key", "~/project"), /invalid directory/);
  assert.equal(tabs, beforeFailure);
  assert.doesNotMatch(declaration.getText(parsed), /rekeyDraft|setSessionKey|setNewSessionDraftId/);
});
