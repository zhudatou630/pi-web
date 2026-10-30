import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRequire } from "node:module";
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
const { selectionFamilies } = await jiti.import("../lib/session-selection.ts");
const noop = () => {};
const reactDom = createRequire(import.meta.url)("react-dom");

function row(props) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(SessionItem, {
    session: { id: "root", modified: "2026-01-01T00:00:00.000Z", firstMessage: "Title" },
    isSelected: false, menuAt: { x: 20, y: 20 }, onClick: noop, onOpenInNewTab: noop,
    onTogglePin: noop, onToggleRead: noop, onToggleArchive: noop, onRequestDelete: noop, ...props,
  })));
}

test("session menu orders normal archive and manual-read actions, toggles labels, and disables running archives", (t) => {
  const previous = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = { innerWidth: 1000, innerHeight: 800 };
  globalThis.document = { body: {} };
  const portal = t.mock.method(reactDom, "createPortal", (children, container) => {
    assert.equal(container, globalThis.document.body);
    return children;
  });
  t.after(() => {
    if (previous === undefined) delete globalThis.window; else globalThis.window = previous;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  });
  const html = row({});
  assert.equal(portal.mock.callCount(), 1);
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
  return new Script(ts.transpileModule(`(${node.getText(ast)})`, { fileName: "inline.tsx", compilerOptions: { target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React } }).outputText)
    .runInNewContext(scope);
}
function callback(name, scope) {
  const declaration = find(ast, (node) => ts.isVariableDeclaration(node) && node.name.getText(ast) === name);
  assert.ok(declaration, name);
  return execute(declaration.initializer.arguments[0], scope);
}
function workspaceRows(scope) {
  return callback("workspaceRows", { ...familyHelpers, workspaceKeyOf, WORKSPACE_SESSION_PREVIEW_LIMIT: 6, WORKSPACE_SESSION_PAGE_SIZE: 20, draggedProjectKey: null, selectionProjectKey: null, selectionFamilies, ...scope })();
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
    workspaceSessionLimits: {}, archiveView: false, expandedArchiveProjectKeys: new Set(),
    archivedSessionIds: { "0": "2026-02-01T00:00:00.000Z", other: "2026-02-01T00:00:00.000Z" },
    runningSessionIds: new Set(["child"]), unreadSessionIds: new Set(["7"]), pinnedSessionIds: ["1"],
  };
  const dragging = workspaceRows({ ...scope, draggedProjectKey: "/p" });
  assert.deepEqual(Array.from(dragging, (r) => r.kind), ["workspace", "workspace"], "drag only collapses the source group, without changing expansion storage");
  assert.equal(scope.expandedWorkspaceKeys.has("/p"), true);
  const normal = workspaceRows(scope);
  assert.deepEqual(Array.from(normal.filter((r) => r.kind === "session"), (r) => r.family.root.id), ["2", "3", "4", "5", "6", "7", "8", "9"]);
  assert.equal(normal.find((r) => r.kind === "session" && r.family.root.id === "9").family.subagents[0].id, "child");
  assert.deepEqual(Array.from(workspaceRows({ ...scope, archiveView: true }), (r) => r.kind), ["workspace", "workspace"], "archive projects start folded");
  const archived = workspaceRows({ ...scope, archiveView: true, expandedArchiveProjectKeys: new Set(["/p", "/other"]) });
  assert.deepEqual(Array.from(archived.filter((r) => r.kind === "session"), (r) => r.family.root.id), ["0", "other"]);
  const single = workspaceRows({ ...scope, archiveView: true, singleProject: true });
  assert.deepEqual(Array.from(single.filter((r) => r.kind === "session"), (r) => r.family.root.id), ["0"]);
  const expanded = workspaceRows({ ...scope, archivedSessionIds: {}, pinnedSessionIds: [], selectedSessionId: null, runningSessionIds: new Set(), unreadSessionIds: new Set(), workspaceSessionLimits: { "/p": 26 } });
  assert.ok(expanded.some((r) => r.kind === "showLess"));
  assert.ok(!workspaceRows({ ...scope, archivedSessionIds: {} }).some((r) => r.kind === "showLess"));
  const allArchived = Object.fromEntries(sessions.map((s) => [s.id, "2026-02-01T00:00:00.000Z"]));
  const archivePage = { ...scope, archiveView: true, expandedArchiveProjectKeys: new Set(["/p"]), archivedSessionIds: allArchived, selectedSessionId: null, runningSessionIds: new Set(), unreadSessionIds: new Set() };
  const paged = workspaceRows(archivePage);
  assert.equal(paged.filter((r) => r.kind === "session").length, 6, "archive pages like the main list");
  assert.equal(paged.find((r) => r.kind === "showMore").limitKey, "archive:/p");
  assert.equal(workspaceRows({ ...archivePage, workspaceSessionLimits: { "/p": 26 } }).filter((r) => r.kind === "session").length, 6, "main-list window does not leak into the archive");
  assert.equal(workspaceRows({ ...archivePage, workspaceSessionLimits: { "archive:/p": 26 } }).filter((r) => r.kind === "session").length, 10);
});

test("archive entry, shared non-danger confirm, pane protection, and subtle search tag use existing UI", () => {
  assert.match(source, /archivedCount > 0 &&[\s\S]*?ariaPressed=\{archiveView\}/);
  const header = source.slice(source.indexOf('{/* Projects and their sessions */}'), source.indexOf('{dropdownOpen && ('));
  assert.ok(header.indexOf('sidebar.addProject') < header.indexOf('sidebar.viewArchive'));
  assert.ok(header.indexOf('sidebar.viewArchive') < header.indexOf('sidebar.toggleSessionSearch'));
  assert.match(source, /archiveView \? setArchiveView\(false\)/);
  assert.match(source, /className=\{archiving \? "is-primary" : "is-danger"\}/);
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

test("selection expands the entire scoped project including pins without changing other previews", () => {
  const sessions = Array.from({ length: 25 }, (_, i) => ({ id: String(i), cwd: "/p", modified: `2026-01-${String(26 - i).padStart(2, "0")}T00:00:00.000Z` }));
  const scope = {
    allFamilies: familyHelpers.listSessionFamilies(sessions), workspaceProjects: [{ key: "/p", root: "/p" }],
    selectedProject: { key: "/p", root: "/p" }, selectedSessionId: null, singleProject: false,
    expandedWorkspaceKeys: new Set(), defaultExpandedWorkspaceKeys: new Set(), workspaceSessionLimits: {},
    archiveView: false, expandedArchiveProjectKeys: new Set(), archivedSessionIds: {},
    runningSessionIds: new Set(), unreadSessionIds: new Set(), pinnedSessionIds: ["24"], selectionProjectKey: "/p",
  };
  const rows = workspaceRows(scope);
  assert.equal(rows.filter((row) => row.kind === "session").length, 25);
  assert.ok(!rows.some((row) => row.kind === "showMore" || row.kind === "showLess"));
  assert.equal(workspaceRows({ ...scope, selectionProjectKey: null }).filter((row) => row.kind === "session").length, 0);
});

test("selection rows have native labelled checkboxes instead of menus and hover actions, with running tooltips", () => {
  const html = row({ selection: { checked: true, disabled: false, onToggle: noop } });
  assert.match(html, /type="checkbox"[^>]*aria-label="Select Title"[^>]*checked=""/);
  assert.doesNotMatch(html, /session-row-actions|session-row-pin|role="menu"/);
  const running = row({ isRunning: true, selection: { checked: false, disabled: true, onToggle: noop } });
  assert.match(running, /Stop running sessions in this family before selecting/);
  assert.match(running, /type="checkbox"[^>]*disabled=""/);
});

test("selection row clicks toggle with Shift and never navigate or open a second tab", () => {
  const click = find(ast, (node) => ts.isJsxAttribute(node) && node.name.getText(ast) === "onClick"
    && node.initializer?.expression?.getText(ast).includes("selection.onToggle(e.shiftKey)"));
  assert.ok(click);
  const toggles = [];
  const handler = (disabled) => execute(click.initializer.expression, {
    selection: { disabled, onToggle: (shift) => toggles.push(shift) }, isLongPressRef: { current: false },
    onClick: () => assert.fail("selection must not navigate"), renaming: false,
  });
  handler(false)({ shiftKey: false });
  handler(false)({ shiftKey: true });
  handler(true)({ shiftKey: false });
  assert.deepEqual(toggles, [false, true]);
});

test("entering a project starts an empty view-scoped selection, and Escape cancels unless busy", () => {
  const declaration = find(ast, (node) => ts.isVariableDeclaration(node) && node.name.getText(ast) === "beginSelection");
  let selection;
  let projectsOpen = false;
  execute(declaration.initializer, {
    archiveView: true, setSelection: (value) => { selection = value; },
    setProjectsOpen: (value) => { projectsOpen = value; }, setSessionSearchOpen: noop,
    setSessionMenu: noop, setProjectMenu: noop, setDeleteConfirm: noop,
  })("/project");
  assert.equal(selection.projectKey, "/project");
  assert.equal(selection.archiveView, true);
  assert.equal(selection.ids.size, 0);
  assert.equal(selection.anchor, null);
  assert.equal(projectsOpen, true);
  const escape = find(ast, (node) => ts.isVariableDeclaration(node) && node.name.getText(ast) === "escape");
  for (const selectionBusy of [false, true]) {
    let cancelled = false;
    const handle = execute(escape.initializer, { selectionBusy, setSelection: () => { cancelled = true; }, setDeleteConfirm: noop });
    handle({ key: "Enter" });
    assert.equal(cancelled, false);
    handle({ key: "Escape" });
    assert.equal(cancelled, !selectionBusy);
  }
});

test("selection toolbar exposes tri-state select-all, disables empty actions, and switches Archive to Restore", () => {
  const bar = find(ast, (node) => ts.isJsxElement(node)
    && node.openingElement.attributes.properties.some((attr) => ts.isJsxAttribute(attr)
      && attr.name.getText(ast) === "className" && attr.initializer?.text === "sidebar-section-row sidebar-selection-bar"));
  assert.ok(bar);
  for (const archiveView of [false, true]) {
    let selection = { ids: new Set(["a"]) };
    const element = execute(bar, {
      React, selectionBusy: false, archiveView, ToolbarIconButton: "button",
      selectionSummary: { ids: [], all: false, indeterminate: true }, eligibleSelectionIds: ["a", "b"],
      t: (key) => key, setSelection: (edit) => { selection = edit(selection); },
      archiveSelection: noop, setDeleteConfirm: noop,
    });
    const input = element.props.children[0].props.children[0];
    const domInput = {};
    input.props.ref(domInput);
    assert.equal(domInput.indeterminate, true);
    input.props.onChange();
    assert.deepEqual([...selection.ids], ["a", "b"]);
    const [archive, del] = element.props.children[1].props.children;
    assert.equal(archive.props.children, archiveView ? "sidebar.restore" : "sidebar.archive");
    assert.equal(archive.props.disabled, true);
    assert.equal(del.props.disabled, true);
  }
});

test("bulk delete closes only successful ids, exits selection, reloads once, then shows failures in the delete popover", async () => {
  const declaration = find(ast, (node) => ts.isVariableDeclaration(node) && node.name.getText(ast) === "deleteSelection");
  const events = [];
  const operation = execute(declaration.initializer, {
    selectionBusy: false, setSelectionBusy: noop,
    fetch: async (url, options) => {
      assert.equal(url, "/api/sessions");
      assert.equal(options.method, "DELETE");
      assert.deepEqual(JSON.parse(options.body), { ids: ["a", "b"] });
      return { ok: true, json: async () => ({ results: [{ id: "a", ok: true }, { id: "b", ok: false, error: "A child session that must be updated is running", code: "child_running" }] }) };
    },
    onSessionDeleted: (id) => events.push(`closed:${id}`),
    setSelection: (value) => { assert.equal(value, null); events.push("exit"); },
    loadSessions: async () => events.push("reload"),
    allSessions: [{ id: "b", name: "Parent" }], getSessionDisplayTitle: (session) => session.name,
    deleteRefusalText: (_t, result) => result.code,
    setDeleteConfirm: (value) => value && events.push(value),
    setError: (error) => events.push(`error:${error}`), t: (key, values) => `${key}:${values?.count}`,
  });
  await operation(["a", "b"], { x: 10, y: 20 });
  assert.deepEqual(JSON.parse(JSON.stringify(events)), ["closed:a", "exit", "reload",
    { kind: "deleteFailed", x: 10, y: 20, title: "sidebar.deleteSessionsFailed:1", detail: "Parent: child_running" }]);
});

test("eligibility changes reconcile the stored selection rather than only masking its summary", () => {
  const effect = find(ast, (node) => ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect"
    && node.arguments[1]?.getText(ast) === "[eligibleSelectionIds]");
  assert.ok(effect);
  let selection = { ids: new Set(["a", "b"]), anchor: "b" };
  const reconcileSessionSelection = (current, eligible) => ({ ...current,
    ids: new Set([...current.ids].filter((id) => eligible.includes(id))), anchor: eligible.includes(current.anchor) ? current.anchor : null });
  for (const eligibleSelectionIds of [["a"], ["a", "b"]]) execute(effect.arguments[0], {
    eligibleSelectionIds, reconcileSessionSelection, setSelection: (edit) => { selection = edit(selection); },
  })();
  assert.deepEqual([...selection.ids], ["a"]);
  assert.equal(selection.anchor, null);
});

test("project menus enter explicit selection instead of whole-project deletion or restore-all", () => {
  const menu = source.slice(source.indexOf("{projectMenu && (() =>"), source.indexOf("{/* Pinned sessions, across all projects */}"));
  assert.match(menu, /beginSelection\(projectMenu\.key\)/);
  assert.match(menu, /sidebar\.selectSessions/);
  assert.match(menu, /!archiveView && \([\s\S]*?sidebar\.archiveOlderThanWeek/);
  assert.doesNotMatch(source, /unarchiveAll|deleteProject\s*=|fetch\("\/api\/projects"|kind: "project"/);
});
