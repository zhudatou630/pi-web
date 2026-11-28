import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";
import React from "react";

const jiti = createJiti(import.meta.url);
const { checkUploadSize, droppedItems, splitDroppedItems, uploadTopEntries } = await jiti.import("../lib/file-upload-client.ts");
const { encodeFilePathForApi, joinFilePath, getRelativeFilePath, getFileDirectory } = await jiti.import("../lib/file-paths.ts");
const source = ts.createSourceFile("FileExplorer.tsx", readFileSync(new URL("./FileExplorer.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name, scope) {
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) return node.initializer.arguments[0];
    return ts.forEachChild(node, find);
  }
  return new Script(ts.transpileModule(find(source).getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText).runInNewContext(scope);
}

function evaluate(expression, scope) {
  return new Script(ts.transpileModule(`(${expression})`, {
    fileName: "explorer-test.tsx",
    compilerOptions: { target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
  }).outputText).runInNewContext(scope);
}
function findNode(predicate) {
  function visit(node) {
    return predicate(node) ? node : ts.forEachChild(node, visit);
  }
  return visit(source);
}

function fixture({ preflight = {}, response = { status: 200, data: { uploaded: ["a.txt"] } } } = {}) {
  const state = { expanded: new Set(), requests: [], uploads: [], mentions: [], refreshes: 0 };
  const scope = {
    cwd: "/project", prevCwdRef: { current: "/project" }, uploadBusy: false, pendingConflict: null, uploadLockRef: { current: false },
    checkUploadSize, droppedItems, splitDroppedItems, uploadTopEntries, encodeFilePathForApi, joinFilePath, getRelativeFilePath, getFileDirectory,
    normalizeFilePathSlashes: (path) => path,
    TREE_ROW_DRAG: "application/x-pi-web-file-row",
    manage: (...args) => { state.moved = args; },
    fileDragDepthRef: { current: 0 },
    setUploadSummary: (value) => { state.summary = value; },
    setHighlightedPaths: (value) => { state.highlights = value; },
    setPendingConflict: (value) => { state.conflict = value; },
    setUploadError: (value) => { state.error = typeof value === "function" ? value(state.error) : value; },
    setUploadProgress() {}, setUploadPhase() {},
    setTreeRefreshKey: () => { state.refreshes++; },
    setExpandedPaths: (update) => { state.expanded = update(state.expanded); },
    rememberExpandedPaths() {}, setSearchQuery() {},
    setDropTargetPath: (value) => { state.target = value; },
    t: (key, vars) => `${key} ${JSON.stringify(vars)}`,
    onAtMentions: (paths, cwd) => state.mentions.push([Array.from(paths), cwd]),
    fetch: async (url) => {
      state.requests.push(url);
      return { ok: true, json: async () => preflight };
    },
    uploadFiles: async (dir, files, strategy) => {
      state.uploads.push([dir, Array.from(files, (file) => file.path), strategy]);
      return response;
    },
  };
  for (const name of ["expandToDirectory", "applyUploadResult", "performUpload", "prepareUpload", "handleExplorerDragEnter", "handleExplorerDragLeave", "handleExplorerDragOver", "handleExplorerDrop"]) scope[name] = callback(name, scope);
  return { state, scope };
}
function event(directory, types = ["Files"], items) {
  return {
    target: { closest: () => directory ? { dataset: { uploadDirectory: directory } } : null },
    dataTransfer: { types, items: items ?? [], files: items ? [] : [new File(["a"], "a.txt")] },
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; },
  };
}
const loose = [{ file: new File(["a"], "a.txt"), path: "a.txt" }];
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("pending conflicts disable the upload button signal, picker and hidden input until resolved", () => {
  const blocked = findNode((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === "uploadBlocked");
  const picker = findNode((node) => ts.isCallExpression(node) && node.expression.getText(source) === "useImperativeHandle");
  const feedback = findNode((node) => ts.isCallExpression(node)
    && node.expression.getText(source) === "useEffect"
    && node.arguments[1]?.elements?.some((dependency) => dependency.getText(source) === "uploadBlocked"));
  const input = findNode((node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === "input"
    && node.attributes.properties.some((attribute) => attribute.name?.getText(source) === "ref"
      && attribute.initializer.expression.getText(source) === "uploadInputRef"));
  let clicks = 0;
  const disabledSignals = [];
  const scope = {
    React, ref: {}, cwd: "/project", uploadBusy: false, pendingConflict: null,
    uploadInputRef: { current: { click: () => { clicks++; } } },
    handleUploadInput() {},
    onUploadBusyChange: (blocked) => disabledSignals.push(blocked),
    useImperativeHandle: (_ref, create) => { scope.handle = create(); },
    useEffect: (effect) => effect(),
  };
  for (const [busy, conflict, expectedBlocked] of [
    [false, null, false],
    [false, { files: [new File(["a"], "a.txt")], conflicts: ["a.txt"] }, true],
    [false, null, false], // Cancel or finish resolving the conflict: picking works again.
    [true, null, true],
  ]) {
    scope.uploadBusy = busy;
    scope.pendingConflict = conflict;
    scope.uploadBlocked = evaluate(blocked.initializer.getText(source), scope);
    evaluate(picker.getText(source), scope);
    evaluate(feedback.getText(source), scope);
    assert.equal(disabledSignals.at(-1), expectedBlocked);
    assert.equal(evaluate(input.getText(source), scope).props.disabled, expectedBlocked);
    const previousClicks = clicks;
    scope.handle.openUploadPicker();
    assert.equal(clicks - previousClicks, expectedBlocked ? 0 : 1);
    assert.equal(scope.pendingConflict, conflict, "opening the picker must not discard a conflict");
  }
});

for (const [label, directory] of [["nested folder row or its icon", "/project/src/deep"], ["file row or empty space", null]]) {
  test(`drop onto ${label} carries its target through preflight, upload, highlighting and mentions`, async () => {
    const { state, scope } = fixture();
    scope.handleExplorerDragOver(event("/project/stale"));
    const drop = event(directory);
    scope.handleExplorerDrop(drop);
    await settle();
    const target = directory ?? "/project";
    assert.equal(drop.prevented, true);
    assert.equal(drop.stopped, true);
    assert.equal(state.requests[0], `/api/files/${encodeFilePathForApi(target)}?type=upload-check`);
    assert.deepEqual(state.uploads, [[target, ["a.txt"], "error"]]);
    assert.deepEqual(Array.from(state.highlights), [`${target}/a.txt`]);
    assert.equal(state.summary.directory, target);
    assert.equal(state.refreshes, 1);
    if (directory) {
      assert.equal(state.expanded.has(directory), true);
      assert.equal(state.expanded.has("/project/src"), true);
    }
    scope.uploadSummary = state.summary;
    callback("addUploadedFilesToChat", scope)();
    assert.deepEqual(state.mentions, [[[directory ? "src/deep/a.txt" : "a.txt"], "/project"]]);
  });
}

test("both preflight and upload-time conflicts preserve the directory for skip/overwrite retry", async () => {
  for (const preflightConflict of [true, false]) {
    const { scope, state } = fixture({
      preflight: preflightConflict ? { conflicts: ["a.txt"] } : {},
      response: { status: 409, data: { conflicts: ["a.txt"] } },
    });
    await scope.prepareUpload(loose, "/project/src/deep");
    assert.equal(state.conflict.directory, "/project/src/deep");
    for (const strategy of ["skip", "overwrite"]) {
      const pending = state.conflict;
      await scope.performUpload(pending.files, strategy, pending.directory);
      assert.deepEqual(state.uploads.at(-1), ["/project/src/deep", ["a.txt"], strategy]);
    }
  }
});

test("internal drags are ignored, and a busy explorer refuses new file drops", async () => {
  const { scope, state } = fixture();
  const internal = event("/project/src", ["text/plain"]);
  scope.handleExplorerDragOver(internal);
  scope.handleExplorerDrop(internal);
  assert.equal(internal.prevented, undefined);
  assert.equal(state.target, undefined);
  scope.uploadBusy = true;
  const busy = event("/project/src");
  scope.handleExplorerDragOver(busy);
  scope.handleExplorerDrop(busy);
  assert.equal(busy.dataTransfer.dropEffect, "none");
  await settle();
  assert.equal(state.requests.length, 0);
});

test("delayed preflight/upload results do not leak into a different explorer cwd", async () => {
  for (const stage of ["preflight", "upload"]) {
    const { scope, state } = fixture();
    const delayed = Promise.withResolvers();
    if (stage === "preflight") scope.fetch = async () => delayed.promise;
    else scope.uploadFiles = async () => delayed.promise;
    const pending = stage === "preflight"
      ? scope.prepareUpload(loose, "/project/src")
      : scope.performUpload(loose, "error", "/project/src");
    scope.prevCwdRef.current = "/other-project";
    delayed.resolve(stage === "preflight"
      ? { ok: true, json: async () => ({ conflicts: ["a.txt"] }) }
      : { status: 200, data: { uploaded: ["a.txt"] } });
    await pending;
    assert.equal(state.conflict, null);
    assert.equal(state.summary ?? null, null);
    assert.equal(state.refreshes, 0);
  }
});

test("moving between row children does not flicker the folder highlight", () => {
  const { scope, state } = fixture();
  const drag = event("/project/src");
  scope.handleExplorerDragEnter(drag);
  scope.handleExplorerDragOver(drag);
  scope.handleExplorerDragEnter(drag);
  scope.handleExplorerDragLeave(drag);
  assert.equal(state.target, "/project/src");
  scope.handleExplorerDragLeave(drag);
  assert.equal(state.target, null);
});

test("folder drops highlight and mention the top-level folder", async () => {
  const { scope, state } = fixture({ response: { status: 200, data: { uploaded: ["folder/a.txt"] } } });
  const batch = [{ name: "a.txt", isFile: true, file: (ready) => ready(loose[0].file) }];
  scope.handleExplorerDrop(event("/project/src", ["Files"], [{ kind: "file", webkitGetAsEntry: () => ({
    isDirectory: true, name: "folder", createReader: () => ({ readEntries: (ready) => ready(batch.splice(0)) }),
  }) }]));
  await settle();
  assert.deepEqual(state.uploads, [["/project/src", ["folder/a.txt"], "error"]]);
  assert.deepEqual([...state.highlights], ["/project/src/folder"]);
  scope.uploadSummary = state.summary;
  callback("addUploadedFilesToChat", scope)();
  assert.deepEqual(state.mentions, [[["src/folder/"], "/project"]]);
});

test("tree drags move rather than upload and use the drop event's directory", () => {
  const { scope, state } = fixture();
  const drop = event("/project/target", [scope.TREE_ROW_DRAG]);
  drop.dataTransfer.getData = () => "/project/source.txt";
  scope.handleExplorerDragOver(drop);
  assert.equal(drop.dataTransfer.dropEffect, "move");
  // A row dragged in from another window is not this page's drag: nothing moves.
  scope.draggedTreePath = null;
  scope.handleExplorerDrop(drop);
  assert.equal(state.moved, undefined);
  scope.draggedTreePath = "/project/source.txt";
  scope.handleExplorerDrop(drop);
  assert.deepEqual(JSON.parse(JSON.stringify(state.moved)), ["/project/source.txt", "move", { directory: "/project/target" }]);
  assert.equal(state.requests.length, 0);
});
