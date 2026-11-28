import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url);
const { dropMentionText, splitDroppedItems } = await jiti.import("../lib/file-upload-client.ts");

const sourceText = readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("ChatWindow.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** Compiles one `const name = useCallback(<arrow>, deps)` from ChatWindow against the given scope. */
function chatWindowCallback(name, context) {
  function findCallback(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      return node.initializer.arguments[0];
    }
    return ts.forEachChild(node, findCallback);
  }
  return new Script(ts.transpileModule(findCallback(source).getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText).runInNewContext(context);
}

/** Runs ChatWindow's real drop path with a fake upload endpoint and chat input. */
async function run(act, { cwd = "/project", response, upload } = {}) {
  const calls = { images: [], uploads: [], mentions: [], notices: [], refreshes: 0 };
  const scope = {
    session: null,
    newSessionCwd: cwd,
    uploadTargetRef: { current: { cwd, draftKey: "draft-1" } },
    onFilesChanged: () => { calls.refreshes++; },
    ownChatInputRef: {
      current: {
        addImages: (images) => calls.images.push(...images),
        insertText: (text) => calls.mentions.push(text),
      },
    },
    addNotice: (notice) => calls.notices.push([notice.type, notice.message]),
    t: (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
    splitDroppedItems,
    dropMentionText,
    uploadFiles: async (target, uploads, strategy) => {
      calls.uploads.push([target, uploads.map((file) => file.path), strategy]);
      return upload ? await upload() : response;
    },
  };
  scope.onDrop = chatWindowCallback("onDrop", scope);
  scope.onAttachFiles = chatWindowCallback("onAttachFiles", scope);
  await act(scope);
  await new Promise((resolve) => setImmediate(resolve));
  return calls;
}

const photo = new File(["x"], "photo.png", { type: "image/png" });
const report = new File(["x"], "report.pdf", { type: "application/pdf" });
const log = new File(["x"], "server.log", { type: "" });

test("the attach button sends picked files down the chat drop path", async () => {
  const calls = await run(
    (scope) => scope.onAttachFiles([photo, report, log]),
    { response: { status: 207, data: { uploaded: ["report.pdf"], skipped: ["server.log"] } } },
  );
  // Images attach to the prompt; the rest are uploaded never replacing a file, then mentioned.
  assert.deepEqual(calls.images, [photo]);
  assert.deepEqual(calls.uploads, [["/project", ["report.pdf", "server.log"], "skip"]]);
  assert.deepEqual(calls.mentions, ["@report.pdf @server.log "]);
  assert.deepEqual(calls.notices, [
    ["success", 'chat.dropUploaded {"count":1,"dir":"/project"}'],
    ["warning", 'chat.dropAlreadyExists {"names":"server.log","dir":"/project"}'],
  ]);
});

test("a drop without a working directory is an error and uploads nothing", async () => {
  const calls = await run((scope) => scope.onDrop([{ kind: "file", file: report }]), { cwd: null });
  assert.deepEqual(calls.uploads, []);
  assert.deepEqual(calls.mentions, []);
  assert.deepEqual(calls.notices, [["error", "chat.dropNeedsCwd"]]);
});

test("a failed file is reported and left out of the mentions", async () => {
  const calls = await run(
    (scope) => scope.onDrop([{ kind: "file", file: report }, { kind: "file", file: log }]),
    { response: { status: 207, data: { uploaded: ["server.log"], errors: [{ name: "report.pdf", error: "disk full" }] } } },
  );
  assert.deepEqual(calls.mentions, ["@server.log "]);
  assert.deepEqual(calls.notices, [
    ["success", 'chat.dropUploaded {"count":1,"dir":"/project"}'],
    ["error", 'chat.dropFailed {"message":"report.pdf: disk full"}'],
  ]);
});

test("folder contents upload and yield one folder mention", async () => {
  const batch = [report, log].map((file) => ({ name: file.name, isFile: true, file: (ready) => ready(file) }));
  const entry = { name: "src", createReader: () => ({ readEntries: (ready) => ready(batch.splice(0)) }) };
  const calls = await run((scope) => scope.onDrop([{ kind: "folder", entry }]), {
    response: { status: 200, data: { uploaded: ["src/report.pdf", "src/server.log"] } },
  });
  assert.deepEqual(calls.uploads, [["/project", ["src/report.pdf", "src/server.log"], "skip"]]);
  assert.deepEqual(calls.mentions, ["@src/ "]);
});

for (const target of [
  { cwd: "/other-project", draftKey: "draft-1" },
  { cwd: "/project", draftKey: "draft-2" },
  { cwd: "/project", draftKey: "session-2" },
]) {
  test(`delayed uploads do not mention files in a changed composer: ${JSON.stringify(target)}`, async () => {
    const delayed = Promise.withResolvers();
    const calls = await run(async (scope) => {
      const uploading = scope.onDrop([report, log].map((file) => ({ kind: "file", file })));
      await new Promise((resolve) => setImmediate(resolve));
      scope.uploadTargetRef.current = target;
      delayed.resolve({ status: 207, data: { uploaded: ["report.pdf"], skipped: ["server.log"] } });
      await uploading;
    }, { upload: () => delayed.promise });
    assert.deepEqual(calls.uploads, [["/project", ["report.pdf", "server.log"], "skip"]]);
    assert.deepEqual(calls.mentions, []);
    assert.deepEqual(calls.notices, [
      ["success", 'chat.dropUploaded {"count":1,"dir":"/project"}'],
      ["warning", 'chat.dropAlreadyExists {"names":"server.log","dir":"/project"}'],
    ]);
    assert.equal(calls.refreshes, 1);
  });
}

test("only successful writes request explorer refresh, not skipped files or failed uploads", async () => {
  for (const [response, expected] of [
    [{ status: 200, data: { uploaded: ["report.pdf"] } }, 1],
    [{ status: 207, data: { skipped: ["report.pdf"] } }, 0],
    [{ status: 207, data: { errors: [{ name: "report.pdf", error: "disk full" }] } }, 0],
    [{ status: 500, data: { error: "failed" } }, 0],
  ]) {
    const calls = await run((scope) => scope.onAttachFiles([report]), { response });
    assert.equal(calls.refreshes, expected);
  }
});
