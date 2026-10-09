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
const { SessionItem } = await jiti.import("./SessionSidebar.tsx");
const familyHelpers = await jiti.import("../lib/session-family.ts");
const { workspaceKeyOf } = await jiti.import("../lib/workspace-key.ts");
const { applyProjectOrderUpdate } = await jiti.import("../lib/project-groups.ts");
const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const searchSource = await readFile(new URL("./SessionSearch.tsx", import.meta.url), "utf8");
const shellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const noop = () => {};

function row(props) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(SessionItem, {
    session: { id: "root", modified: "2026-01-01T00:00:00.000Z", firstMessage: "Title" },
    isSelected: false, menuAt: { x: 20, y: 20 }, onClick: noop, onOpenInNewTab: noop,
    onTogglePin: noop, onToggleRead: noop, onToggleArchive: noop, onRequestDelete: noop, ...props,
  })));
}

test("session menu orders normal archive and manual-read actions, toggles labels, and disables running archives", (t) => {
  const previous = globalThis.window;
  globalThis.window = { innerWidth: 1000, innerHeight: 800 };
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  const html = row({});
  const items = [...html.matchAll(/<button[^>]*role="menuitem"[^>]*>([\s\S]*?)<\/button>/g)]
    .map((match) => match[1].replace(/<[^>]+>/g, "").trim());
  assert.deepEqual(items, ["Open in new tab", "Pin session", "Rename", "Mark as unread", "Archive", "Delete"]);
  assert.match(row({ isArchived: true, isUnread: true }), /Mark as read[\s\S]*Unarchive/);
  assert.match(row({ isRunning: true }), /role="menuitem" disabled=""[^>]*>[\s\S]*?Archive/);
  assert.doesNotMatch(html, /class="is-danger"[^>]*>[\s\S]*?Archive/);
  assert.doesNotMatch(row({ session: { id: "draft", transient: true, firstMessage: "Draft", modified: "2026-01-01T00:00:00.000Z" } }), />Archive</);
  const actions = source.slice(source.indexOf('{/* Action buttons'), source.indexOf('{menuAt &&'));
  assert.doesNotMatch(actions, /onToggleArchive/);
});

const ast = ts.createSourceFile("SessionSidebar.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(node, predicate) {
  if (predicate(node)) return node;
  return ts.forEachChild(node, (child) => find(child, predicate));
}
function execute(node, scope) {
  return new Script(ts.transpileModule(`(${node.getText(ast)})`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText)
    .runInNewContext(scope);
}
function callback(name, scope) {
  const declaration = find(ast, (node) => ts.isVariableDeclaration(node) && node.name.getText(ast) === name);
  assert.ok(declaration, name);
  return execute(declaration.initializer.arguments[0], scope);
}
function workspaceRows(scope) {
  return callback("workspaceRows", { ...familyHelpers, workspaceKeyOf, WORKSPACE_SESSION_PREVIEW_LIMIT: 6, draggedProjectKey: null, ...scope })();
}

test("the actual virtual row model hides archived families, keeps cross-project subagents, and shows the scoped archive", () => {
  const sessions = Array.from({ length: 10 }, (_, i) => ({ id: String(i), cwd: "/p", modified: `2026-01-${String(10 - i).padStart(2, "0")}T00:00:00.000Z` }));
  sessions.push({ id: "child", cwd: "/other", modified: "2026-01-01T00:00:00.000Z", relation: { kind: "subagent", parentSessionId: "9" } });
  sessions.push({ id: "other", cwd: "/other", modified: "2026-01-01T00:00:00.000Z" });
  const scope = {
    allFamilies: familyHelpers.listSessionFamilies(sessions),
    workspaceProjects: [{ key: "/p", root: "/p" }, { key: "/other", root: "/other" }],
    selectedProject: { key: "/p", root: "/p" }, selectedSessionId: "8", singleProject: false,
    expandedWorkspaceKeys: new Set(["/p", "/other"]), defaultExpandedWorkspaceKeys: new Set(),
    workspaceSessionLimits: {}, archiveView: false, collapsedArchiveProjectKeys: new Set(),
    archivedSessionIds: { "0": "2026-02-01T00:00:00.000Z", other: "2026-02-01T00:00:00.000Z" },
    runningSessionIds: new Set(["child"]), unreadSessionIds: new Set(["7"]), pinnedSessionIds: ["1"],
  };
  const dragging = workspaceRows({ ...scope, draggedProjectKey: "/p" });
  assert.deepEqual(Array.from(dragging, (r) => r.kind), ["workspace", "workspace"], "drag only collapses the source group, without changing expansion storage");
  assert.equal(scope.expandedWorkspaceKeys.has("/p"), true);
  const normal = workspaceRows(scope);
  assert.deepEqual(Array.from(normal.filter((r) => r.kind === "session"), (r) => r.family.root.id), ["2", "3", "4", "5", "6", "7", "8", "9"]);
  assert.equal(normal.find((r) => r.kind === "session" && r.family.root.id === "9").family.subagents[0].id, "child");
  const archived = workspaceRows({ ...scope, archiveView: true });
  assert.deepEqual(Array.from(archived.filter((r) => r.kind === "session"), (r) => r.family.root.id), ["0", "other"]);
  const single = workspaceRows({ ...scope, archiveView: true, singleProject: true });
  assert.deepEqual(Array.from(single.filter((r) => r.kind === "session"), (r) => r.family.root.id), ["0"]);
  const expanded = workspaceRows({ ...scope, archivedSessionIds: {}, pinnedSessionIds: [], selectedSessionId: null, runningSessionIds: new Set(), unreadSessionIds: new Set(), workspaceSessionLimits: { "/p": 26 } });
  assert.ok(expanded.some((r) => r.kind === "showLess"));
  assert.ok(!workspaceRows({ ...scope, archivedSessionIds: {} }).some((r) => r.kind === "showLess"));
});

test("archive entry, shared non-danger confirm, pane protection, and subtle search tag use existing UI", () => {
  assert.match(source, /archivedCount > 0 &&[\s\S]*?ariaPressed=\{archiveView\}/);
  const header = source.slice(source.indexOf('{/* Projects and their sessions */}'), source.indexOf('{dropdownOpen && ('));
  assert.ok(header.indexOf('sidebar.addProject') < header.indexOf('sidebar.viewArchive'));
  assert.ok(header.indexOf('sidebar.viewArchive') < header.indexOf('sidebar.toggleSessionSearch'));
  assert.match(source, /archiveView \? setArchiveView\(false\)/);
  assert.match(source, /className=\{archiving \? undefined : "is-danger"\}/);
  assert.match(source, /archiveProjectConfirm/);
  assert.match(source, /olderCount === 0/);
  assert.match(source, /visibleSessionIds: new Set\(visibleSessionIds\)/);
  assert.match(shellSource, /visibleSessionIds=\{\[primaryTab\?\.session\?\.id[\s\S]*?isSplitActive \? secondaryTab\?\.session\?\.id/);
  assert.match(searchSource, /archivedSessionIds\?\.has\(session\.id\)[\s\S]*?text-\[10px\] text-text-dim/);
  assert.doesNotMatch(searchSource, /fontWeight|italic/);
});

test("archive and unarchive are optimistic before the single request resolves, then reload and surface refusals", async () => {
  let archived = { unrelated: "2026-01-01T00:00:00.000Z" };
  let pinned = ["root", "unrelated"];
  const requests = [];
  const events = [];
  let resolveRequest;
  let fail = false;
  const update = callback("updateSessionSidebarState", {
    setArchivedSessionIds(edit) { archived = edit(archived); events.push("archived"); },
    setPinnedSessionIds(edit) { pinned = edit(pinned); events.push("pinned"); },
    fetch(url, options) { requests.push({ url, body: JSON.parse(options.body) }); return new Promise((resolve) => { resolveRequest = resolve; }); },
    async loadSessions() {
      events.push("reload");
      if (fail) archived = { root: "2026-01-01T00:00:00.000Z" };
    },
    setError(message) { events.push(message); },
  });
  const archiving = update("root", { archived: true });
  assert.ok(Number.isFinite(Date.parse(archived.root)), "archive flag is set before the response");
  assert.equal(archived.unrelated, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(pinned, ["unrelated"], "optimistic archive clears its pin only");
  assert.deepEqual(requests, [{ url: "/api/sessions/root", body: { archived: true } }]);
  assert.ok(!events.includes("reload"));
  resolveRequest({ ok: true });
  await archiving;
  assert.equal(events.at(-1), "reload");

  events.length = 0;
  fail = true;
  const unarchiving = update("root", { archived: false });
  assert.equal(Object.hasOwn(archived, "root"), false, "unarchive flag clears before the response");
  assert.deepEqual(pinned, ["unrelated"]);
  resolveRequest({ ok: false, json: async () => ({ error: "Archive refused" }) });
  await unarchiving;
  assert.ok(archived.root, "reload restores authoritative state on refusal");
  assert.deepEqual(events, ["archived", "reload", "Archive refused"]);

  requests.length = 0;
  fail = false;
  const bulk = update(["root", "second"], { archived: true });
  assert.deepEqual(requests, [{ url: "/api/sessions", body: { ids: ["root", "second"], archived: true } }]);
  assert.equal(archived.root, archived.second);
  resolveRequest({ ok: true });
  await bulk;
});

test("relative project moves are optimistic and queued, then reconcile pending intentions and surface failure", async () => {
  let order = ["a", "b", "c"];
  let serverOrder = [...order];
  const pendingProjectOps = { current: [] };
  const projectWriteQueue = { current: Promise.resolve() };
  const requests = [];
  const events = [];
  const update = callback("updateProjectOrder", {
    pendingProjectOps, projectWriteQueue, applyProjectOrderUpdate,
    setProjectOrder(edit) { order = edit(order); },
    fetch(url, options) {
      const body = JSON.parse(options.body);
      return new Promise((resolve) => requests.push({ url, body, resolve }));
    },
    async loadSessions() {
      order = pendingProjectOps.current.reduce(applyProjectOrderUpdate, serverOrder);
      events.push("reload");
    },
    setError(message) { events.push(message); },
  });
  update({ move: "a", after: "b" });
  const firstWrite = projectWriteQueue.current;
  update({ move: "c", before: "b" });
  assert.deepEqual(order, ["c", "b", "a"], "both intentions render before any response");
  await Promise.resolve();
  assert.equal(requests.length, 1, "one in-flight relative write per browser");
  assert.deepEqual(requests[0].body, { move: "a", after: "b" });
  requests[0].resolve({ ok: false, json: async () => ({ error: "Move refused" }) });
  await firstWrite;
  assert.deepEqual(events, ["reload", "Move refused"]);
  assert.deepEqual(order, ["a", "c", "b"], "failed move rolls back, next intention remains optimistic");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].body, { move: "c", before: "b" });
  serverOrder = applyProjectOrderUpdate(serverOrder, requests[1].body);
  requests[1].resolve({ ok: true });
  await projectWriteQueue.current;
  assert.deepEqual(order, serverOrder);
  assert.equal(pendingProjectOps.current.length, 0);
});

test("the archive view exits when its relevant count becomes zero, and the project switcher has no archive icons", () => {
  const effect = find(ast, (node) => ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect"
    && node.arguments[1]?.getText(ast) === "[archiveView, archivedCount]");
  assert.ok(effect, "count changes must trigger the exit effect");
  for (const [archiveView, archivedCount, expected] of [[true, 0, false], [true, 1, undefined], [false, 0, undefined]]) {
    let next;
    execute(effect.arguments[0], { archiveView, archivedCount, setArchiveView(value) { next = value; } })();
    assert.equal(next, expected);
  }
  const dropdown = source.slice(source.indexOf("{workspaceProjects.map((project) =>"), source.indexOf("{/* Single-project mode: this list"));
  assert.doesNotMatch(dropdown, /archiveProject|<ArchiveIcon \/>/);
});

test("the archive view's project menu restores instead of archiving or deleting", () => {
  const menu = source.slice(source.indexOf("{projectMenu && (() =>"), source.indexOf("{/* Pinned sessions, across all projects */}"));
  assert.match(menu, /archiveView \? \([\s\S]*?updateSessionSidebarState\(projectArchivedIds, \{ archived: false \}\)/);
  assert.match(menu, /\{!archiveView && <button[\s\S]*?sidebar\.deleteSessions/);
});
