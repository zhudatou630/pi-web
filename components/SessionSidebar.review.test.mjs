import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { createJiti } from "jiti";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const file = ts.createSourceFile("SessionSidebar.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(node, predicate) {
  if (predicate(node)) return node;
  return ts.forEachChild(node, (child) => find(child, predicate));
}
function declaration(name) {
  const node = find(file, (node) => ts.isVariableDeclaration(node) && node.name.getText(file) === name);
  assert.ok(node, name);
  return node;
}
function evaluate(node, bindings) {
  const js = ts.transpileModule(`return (${node.getText(file)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

// Execute the real hook callback with deferred HTTP replies and React-style state updates.
function renameHarness(reload = true) {
  let names = new Map([["p", "original"], ["other", "other-original"]]);
  const server = new Map(names);
  const pendingProjectRenames = evaluate(declaration("pendingProjectRenames").initializer, { useRef: (current) => ({ current }) });
  const projectRenameQueues = evaluate(declaration("projectRenameQueues").initializer, { useRef: (current) => ({ current }) });
  const responses = new Map();
  const calls = [];
  const errors = [];
  const bindings = {
    pendingProjectRenames, projectRenameQueues,
    setProjectNames: (update) => { names = update(names); },
    setError: (error) => errors.push(error),
    loadSessions: async () => { if (reload && !pendingProjectRenames.current) names = new Map(server); },
    fetch: async (_url, options) => {
      const { projectKey, name } = JSON.parse(options.body);
      calls.push(name);
      const response = await responses.get(name).promise;
      if (response.ok) server.set(projectKey, name);
      return response;
    },
  };
  return {
    calls, errors, server, pendingProjectRenames, projectRenameQueues,
    get names() { return names; },
    submit: (name, key = "p") => {
      responses.set(name, Promise.withResolvers());
      return evaluate(declaration("renameProject").initializer.arguments[0], { ...bindings, projectNames: names })(key, name);
    },
    reply: (name, ok) => responses.get(name).resolve({ ok, status: ok ? 200 : 500, json: async () => ({ error: `refused ${name}` }) }),
  };
}

test("same-project renames serialize even when the newer HTTP reply is ready first", async () => {
  const h = renameHarness();
  const first = h.submit("older");
  const second = h.submit("newer");
  assert.equal(h.names.get("p"), "newer", "both submissions apply optimistically");
  await flush();
  assert.deepEqual(h.calls, ["older"], "the newer PATCH must not start yet");
  h.reply("newer", true); // A concurrent implementation would persist this before the older request.
  await flush();
  assert.equal(h.server.get("p"), "original");
  h.reply("older", true);
  await Promise.all([first, second]);
  assert.deepEqual(h.calls, ["older", "newer"]);
  assert.equal(h.server.get("p"), "newer");
  assert.equal(h.names.get("p"), "newer");
  assert.equal(h.pendingProjectRenames.current, 0);
  assert.equal(h.projectRenameQueues.current.size, 0);
});

test("queued failures roll back to the last confirmed name, not a failed optimistic name", async () => {
  for (const firstOk of [false, true]) {
    for (const secondOk of [false, true]) {
      const h = renameHarness(false); // Also restore correctly if the reconciliation GET fails.
      const first = h.submit("older");
      const second = h.submit("newer");
      await flush();
      h.reply("older", firstOk);
      await first;
      await flush();
      assert.equal(h.names.get("p"), "newer", "an earlier failure cannot discard the latest intent");
      h.reply("newer", secondOk);
      await second;
      const expected = secondOk ? "newer" : firstOk ? "older" : "original";
      assert.equal(h.names.get("p"), expected);
      assert.equal(h.server.get("p"), expected);
      assert.equal(h.errors.length, Number(!firstOk) + Number(!secondOk));
      assert.equal(h.pendingProjectRenames.current, 0);
      assert.equal(h.projectRenameQueues.current.size, 0);
    }
  }
});

test("a different project's write is independent and a single failure restores its alias", async () => {
  const h = renameHarness();
  const first = h.submit("older");
  const other = h.submit("other-new", "other");
  await flush();
  assert.deepEqual(h.calls, ["older", "other-new"]);
  h.reply("other-new", false);
  await other;
  assert.equal(h.names.get("other"), "other-original");
  assert.equal(h.names.get("p"), "older");
  h.reply("older", true);
  await first;
});

const { getSessionListIndices } = await createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true }).import("./SessionSidebar.tsx");

test("virtualization retains the renaming project as well as the focused session across scrolls", () => {
  const workspaceRows = Array.from({ length: 2000 }, (_, index) => index % 20 === 0
    ? { kind: "workspace", project: { key: `p${index}` } }
    : { kind: "session", family: { root: { id: `s${index}` } } });
  for (const renamingProjectKey of ["p0", "p1980"]) {
    for (const listScrollTop of [0, 10000, 50000]) {
      const indices = evaluate(declaration("virtualIndices").initializer, {
        getSessionListIndices, workspaceRows, listScrollTop, listViewportH: 335,
        focusedSessionId: "s1999", renamingProjectKey,
      });
      assert.ok(indices.includes(workspaceRows.findIndex((row) => row.project?.key === renamingProjectKey)));
      assert.ok(indices.includes(1999));
      assert.ok(indices.length <= 31, "retain rows, not the entire intervening range");
      assert.equal(new Set(indices).size, indices.length);
      assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
    }
  }
  assert.deepEqual(getSessionListIndices(5, 10000, 335, 0, 0), [0, 1, 2, 3, 4]);
  assert.deepEqual(getSessionListIndices(0, 10000, 335, 0, 0), []);
});

test("project menus clamp using their measured height on desktop, phone, and in the archive", () => {
  const expression = find(file, (node) => ts.isBinaryExpression(node) && node.left.getText(file) === "projectMenu"
    && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken);
  assert.ok(expression);
  for (const archiveView of [false, true]) {
    for (const [innerHeight, rowHeight] of [[900, 28], [640, 32]]) {
      const projectMenu = { key: "p", cwd: "/p", x: 30, y: innerHeight - 5 };
      const noop = () => {};
      let savedPaths = ["/p", "/keep"];
      const menu = evaluate(expression.right, {
        pinnedCwds: savedPaths, recentProjects: archiveView ? [{ key: "p" }] : [],
        projectFor: (cwd) => ({ key: cwd.slice(1) }), onUpdatePinnedCwds: (update) => { savedPaths = update(savedPaths); },
        React, projectMenu, archiveView, window: { innerWidth: 390, innerHeight },
        projectActivity: new Map(), archiveOlderFamilies: () => [], archivedFamilies: [],
        workspaceProjects: [{ key: "p" }], workspaceKeyOf: (session) => session.projectKey,
        selectionBusy: false, beginSelection: noop, t: (key) => key, ArchiveIcon: noop,
        setProjectMenu: noop, setSelectedCwd: noop, setExplorerOpen: noop, saveExplorerOpen: noop,
        setRenamingProjectKey: noop, moveProject: noop, updateSessionSidebarState: noop, setDeleteConfirm: noop,
      });
      const items = menu.props.children.flat(Infinity).filter((child) => child?.props?.role === "menuitem");
      assert.equal(items.length, archiveView ? 3 : 7, "includes all disabled items");
      const remove = items.find((item) => item.props.children === "sidebar.removeEmptyProject");
      if (archiveView) assert.equal(remove, undefined, "a project with history cannot be forgotten");
      else {
        remove.props.onClick();
        assert.deepEqual(savedPaths, ["/keep"], "forget only the empty project, without accessing its directory");
      }
      // Supply the DOM measurement including the actual row count, padding and borders.
      const element = { offsetHeight: items.length * rowHeight + 10, style: {} };
      menu.props.ref(element);
      const top = Number.parseFloat(element.style.top);
      assert.ok(top >= 4);
      assert.equal(top + element.offsetHeight, innerHeight - 4);
      assert.equal(menu.props.style.overflowY, "auto", "short viewports can still reach every item");
      menu.props.ref(null); // React's unmount ref callback is harmless.
    }
  }
});
