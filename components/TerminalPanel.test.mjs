import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { Script } from "node:vm";
import xterm from "@xterm/xterm";
import ts from "typescript";
import { createTerminalWriter, terminalRequest } from "../lib/terminal-client.ts";

const source = ts.createSourceFile("TerminalPanel.tsx", readFileSync(new URL("./TerminalPanel.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const outputHelper = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "createTerminalOutput");
assert.ok(outputHelper);
const createTerminalOutput = new Script(ts.transpileModule(`(${outputHelper.getText(source)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText).runInNewContext();

test("only replayed snapshots suppress query replies, without dropping queued typing", async (t) => {
  const query = "\x1b[c";
  const reply = "\x1b[?1;2c";
  const scenarios = [
    { name: "new shell", snapshot: { data: query, offset: 3, reset: true }, replies: [reply] },
    { name: "first reconnect before any output", earlier: { data: "", offset: 0, reset: true }, snapshot: { data: query, offset: 3, reset: false }, replies: [reply] },
    { name: "reconnect with a cursor (output never drawn here)", earlier: { data: "\x1b[6n", offset: 4 }, snapshot: { data: query, offset: 7, reset: false }, replies: ["\x1b[1;1R", reply] },
    { name: "reconnect past the kept history (output never drawn here)", earlier: { data: "\x1b[6n", offset: 4 }, snapshot: { data: query, offset: 300_000, reset: true }, replies: ["\x1b[1;1R", reply] },
    { name: "restored tab or explicit reconnect", attachToExistingShell: true, snapshot: { data: query, offset: 3, reset: true }, replies: [] },
  ];
  for (const { name, attachToExistingShell = false, earlier, snapshot, replies } of scenarios) {
    await t.test(name, async () => {
      const terminal = new xterm.Terminal();
      try {
        const output = createTerminalOutput(terminal, attachToExistingShell);
        const sent = [];
        terminal.onData((data) => { if (!output.isReplayReply(data)) sent.push(data); });
        const write = (event) => output.write({ type: "output", ...event });
        if (earlier) write(earlier);
        write(snapshot);
        terminal.input("typed");
        write({ data: "\x1b[>c", offset: snapshot.offset + 4 });
        await new Promise((resolve) => terminal.write("", resolve));
        assert.deepEqual(sent, ["typed", ...replies, "\x1b[>0;276;0c"]);
      } finally {
        terminal.dispose();
      }
    });
  }
});

test("typing while xterm parses a replay still reaches the shell", async () => {
  const terminal = new xterm.Terminal();
  try {
    const output = createTerminalOutput(terminal, true);
    const sent = [];
    terminal.onData((data) => { if (!output.isReplayReply(data)) sent.push(data); });
    terminal.input("a"); // user input makes xterm parse the next write synchronously
    output.write({ type: "output", data: "\x1b[c", offset: 3, reset: true });
    terminal.input("typed");
    await new Promise((resolve) => terminal.write("", resolve));
    assert.deepEqual(sent, ["a", "typed"]);
  } finally {
    terminal.dispose();
  }
});

test("terminal errors preserve server diagnostics and explain non-JSON responses", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch");
  for (const body of [null, "<html>Server error</html>", "null"]) {
    fetch.mock.mockImplementation(async () => new Response(body, { status: 500 }));
    await assert.rejects(terminalRequest("/api/terminal"), /HTTP 500.*pi-web server log/);
  }
  fetch.mock.mockImplementation(async () => Response.json({ error: "Native module missing; run npm rebuild node-pty" }, { status: 500 }));
  await assert.rejects(terminalRequest("/api/terminal"), /Native module missing; run npm rebuild node-pty/);
});

test("a delayed input request cannot be overtaken by typing or resize", async (t) => {
  const received = [];
  let finishFirst;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    received.push(JSON.parse(options.body));
    if (received.length === 1) await new Promise((resolve) => { finishFirst = resolve; });
    return Response.json({ success: true });
  });
  const writer = createTerminalWriter("id", assert.fail);
  writer.write("a");
  writer.resize(100, 30);
  writer.write("b\r");
  await setImmediate();
  assert.equal(received.length, 1);
  finishFirst();
  await setImmediate();
  assert.deepEqual(received, [
    { type: "input", data: "a" },
    { type: "resize", cols: 100, rows: 30 },
    { type: "input", data: "b\r" },
  ]);
  await writer.stop();
});

test("large Unicode pastes preserve characters while bounding input requests", async (t) => {
  const chunks = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    chunks.push(JSON.parse(options.body).data);
    return Response.json({ success: true });
  });
  const writer = createTerminalWriter("id", assert.fail);
  const text = "a".repeat(32767) + "\u{1f600}".repeat(40000);
  writer.write(text);
  await setImmediate();
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => chunk.length <= 65536 && chunk.isWellFormed()));
  await writer.stop();
});

test("typing during a slow request is batched into the next ordered write", async (t) => {
  const received = [];
  let release;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    received.push(JSON.parse(options.body).data);
    if (received.length === 1) await new Promise((resolve) => { release = resolve; });
    return Response.json({ success: true });
  });
  const writer = createTerminalWriter("id", assert.fail);
  writer.write("first");
  await setImmediate();
  for (const character of "a long command\r") writer.write(character);
  assert.deepEqual(received, ["first"]);
  release();
  await setImmediate();
  assert.deepEqual(received, ["first", "a long command\r"]);
  await writer.stop();
});

test("failed or stopped delivery discards queued input without retrying commands", async (t) => {
  const errors = [];
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ error: "gone" }, { status: 404 }));
  const writer = createTerminalWriter("id", (error) => errors.push(error.message));
  writer.write("first");
  writer.write("second");
  await setImmediate();
  assert.deepEqual(errors, ["gone"]);
  assert.equal(fetch.mock.callCount(), 1);
  await writer.stop();
  writer.write("third");
  await setImmediate();
  assert.equal(fetch.mock.callCount(), 1);
});
