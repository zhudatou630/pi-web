import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./[...path]/route.ts", import.meta.url), "utf8");
const start = source.indexOf('if (type === "watch")');
const end = source.indexOf("// type === \"list\"", start);
assert.notEqual(start, -1, "watch route not found");
assert.notEqual(end, -1, "watch route end not found");
const watchBlock = source.slice(start, end);

test("file watching survives same-path replacement", () => {
  assert.match(watchBlock, /watcher = fs\.watch\(watchedDirectory/);
  assert.match(watchBlock, /samePath\(path\.join\(watchedDirectory, changedName\.toString\(\)\), filePath\)/);
  assert.match(watchBlock, /s\.ctimeMs === lastCtimeMs/);
  assert.match(watchBlock, /s\.ino === lastIno/);
  assert.match(watchBlock, /lastExists/);
});

test("a missing target can be watched after its parent is authorized", () => {
  assert.match(source, /if \(type !== "watch"\)[\s\S]*error: "Not found"/);
  assert.match(source, /const existingAuthorizationPath = stat \? filePath : path\.dirname\(filePath\)/);
  assert.match(watchBlock, /lastExists = stat !== undefined/);
});

test("connected is emitted only after the watcher exists", () => {
  const watcher = watchBlock.indexOf("watcher = fs.watch");
  const connected = watchBlock.indexOf('send("connected"');
  assert.ok(watcher >= 0, "watcher creation missing");
  assert.ok(connected > watcher, "connected emitted before watcher creation");
});

test("request abort releases the watcher and its heartbeat, even without stream cancel", async (t) => {
  const { default: ts } = await import("typescript");
  const { default: path } = await import("node:path");
  t.mock.timers.enable({ apis: ["setInterval"] });
  let closes = 0;
  let released = 0;
  const watcher = { on() {}, close() { closes++; } };
  const run = new Function("request", "fs", "path", "stat", "filePath", "type", "getFileVersion", "registerSseConnection", ts.transpileModule(watchBlock, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText);
  const abort = new AbortController();
  const response = run(new Request("http://localhost/watch", { signal: abort.signal }), { watch: () => watcher }, path,
    { isFile: () => true }, "/tmp/test", "watch", () => "version", () => () => { released++; });
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: connected/);
  t.mock.timers.tick(30_000);
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: heartbeat/);
  abort.abort();
  assert.equal(closes, 1);
  assert.equal((await reader.read()).done, true);
  assert.equal(released, 1);
  t.mock.timers.tick(60_000);
  assert.equal(closes, 1);
});
