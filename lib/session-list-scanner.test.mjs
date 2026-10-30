import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { createJiti } from "jiti";

const reads = [];
let onReadEnd;
let readdirHook;
const readdir = fsPromises.readdir;
mock.method(fsPromises, "readdir", (path, ...args) => readdirHook ? readdirHook(path, ...args) : readdir(path, ...args));
const createReadStream = fs.createReadStream;
mock.method(fs, "createReadStream", (path, options, ...args) => {
  reads.push({ path, start: options?.start ?? 0 });
  const stream = createReadStream(path, options, ...args);
  stream.once("end", () => onReadEnd?.(path));
  return stream;
});
syncBuiltinESMExports();

const jiti = createJiti(import.meta.url);
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { listSessionsIncremental, resetSessionScanIndexForTests, flushSessionScanIndexForTests, scanSessionFileInfo } = await jiti.import("./session-list-scanner.ts");
const { listAllSessions, invalidateSessionListCache } = await jiti.import("./session-reader.ts");
const timestamp = "2026-01-01T00:00:00.000Z";
const line = (entry) => JSON.stringify(entry) + "\n";
const message = (id, role, content, time = timestamp) => ({
  type: "message", id, parentId: null, timestamp: time, message: { role, content },
});

function fixture(t) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = fs.mkdtempSync(join(tmpdir(), "pi-web-scanner-"));
  const dir = join(root, "sessions", "project");
  fs.mkdirSync(dir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = root;
  resetSessionScanIndexForTests();
  invalidateSessionListCache();
  t.after(() => {
    resetSessionScanIndexForTests();
    invalidateSessionListCache();
    globalThis.__piSessionPathCache = undefined;
    globalThis.__piPathToSessionIdCache = undefined;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  function write(id, entries = [], extraHeader = {}) {
    const path = join(dir, `${id}.jsonl`);
    fs.writeFileSync(path, line({ type: "session", version: 3, id, cwd: root, timestamp, ...extraHeader }) + entries.map(line).join(""));
    return path;
  }
  return { root, dir, write, indexPath: join(root, "pi-web-session-index.json") };
}

async function sdkMetadata() {
  return (await SessionManager.listAll()).map((session) => {
    const info = { ...session };
    delete info.allMessagesText;
    return info;
  });
}

test("matches SDK metadata and tie ordering across cache hits, mutations, and restarts", async (t) => {
  const { write, indexPath } = fixture(t);
  const a = write("a", [
    message("a1", "user", [{ type: "image", data: "ignored", mimeType: "image/png" }, { type: "text", text: "first" }, { type: "text", text: "request" }]),
    message("a2", "assistant", [{ type: "text", text: "answer" }]),
    message("a3", "toolResult", [{ type: "text", text: "output" }], "2026-01-03T00:00:00.000Z"),
    { type: "custom", data: "x".repeat(256 * 1024) },
  ]);
  const b = write("b", [message("b1", "user", "forked request")], { parentSession: a });
  const c = write("c");
  async function check(label, expectedReads) {
    const expected = await sdkMetadata();
    reads.length = 0;
    assert.deepEqual(await listSessionsIncremental(), expected, label);
    assert.deepEqual(reads.map((read) => read.path).sort(), [...expectedReads].sort(), `${label}: scanned files`);
    flushSessionScanIndexForTests();
  }

  await check("cold", [a, b, c]);
  await check("warm", []);
  if (process.platform !== "win32") assert.equal(fs.statSync(indexPath).mode & 0o777, 0o600);
  resetSessionScanIndexForTests();
  await check("persisted cache", []);

  fs.appendFileSync(a, line({ type: "session_info", name: "  Renamed  " }));
  await check("rename preserves equal-time order", [a]);
  fs.appendFileSync(a, line({ type: "session_info", name: " " }));
  await check("explicit name clear", [a]);
  fs.appendFileSync(b, line(message("b2", "assistant", "new activity", "2026-01-02T00:00:00.000Z")));
  await check("append", [b]);
  write("a", [message("replacement", "user", "rewritten")]);
  await check("whole-file rewrite", [a]);
  const d = write("d", [message("d1", "user", "new session")]);
  fs.rmSync(c);
  await check("create and delete", [d]);

  resetSessionScanIndexForTests();
  fs.appendFileSync(a, line({ type: "session_info", name: "changed while stopped" }));
  fs.rmSync(b);
  await check("restart revalidates changed and deleted files", [a]);
  const persisted = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  assert.deepEqual(Object.keys(persisted.entries).sort(), [a, d].sort());
});

test("discards malformed persisted entries and rebuilds the list from valid session files", async (t) => {
  const { write, indexPath } = fixture(t);
  const a = write("a", [message("a1", "user", "healthy")]);
  write("b", [message("b1", "user", "also healthy")]);
  const expected = await listSessionsIncremental();
  flushSessionScanIndexForTests();
  const pristine = fs.readFileSync(indexPath, "utf8");
  const corruptions = [
    ["missing fingerprint", (entry) => { delete entry.fp; }],
    ["null fingerprint", (entry) => { entry.fp = null; }],
    ["string size", (entry) => { entry.fp.size = String(entry.fp.size); }],
    ["negative size", (entry) => { entry.fp.size = -1; }],
    ["invalid mtime", (entry) => { entry.fp.mtimeMs = null; }],
    ["missing metadata", (entry) => { delete entry.info; }],
    ["mismatched path", (entry) => { entry.info.path = "/elsewhere/session.jsonl"; }],
    ["invalid id", (entry) => { entry.info.id = null; }],
    ["invalid cwd", (entry) => { entry.info.cwd = []; }],
    ["invalid first message", (entry) => { entry.info.firstMessage = 1; }],
    ["invalid name", (entry) => { entry.info.name = {}; }],
    ["invalid parent", (entry) => { entry.info.parentSessionPath = []; }],
    ["invalid count", (entry) => { entry.info.messageCount = -1; }],
    ["invalid created", (entry) => { entry.info.created = "not a date"; }],
    ["invalid modified", (entry) => { entry.info.modified = "not a date"; }],
    ["null date", (entry) => { entry.info.created = null; }],
    ["missing inode", (entry) => { delete entry.fp.ino; }],
    ["invalid device", (entry) => { entry.fp.dev = null; }],
    ["invalid offset", (entry) => { entry.resume.offset = entry.fp.size + 1; }],
    ["invalid sample", (entry) => { entry.resume.head = "bogus"; }],
    ["invalid checkpoint count", (entry) => { entry.resume.state.messageCount = -1; }],
    ["invalid checkpoint preview", (entry) => { entry.resume.state.firstMessage = {}; }],
    ["invalid checkpoint flag", (entry) => { delete entry.resume.state.hasFirstMessage; }],
    ["invalid checkpoint timestamp", (entry) => { entry.resume.state.lastActivityTime = "yesterday"; }],
  ];
  for (const [label, corrupt] of corruptions) {
    const index = JSON.parse(pristine);
    corrupt(index.entries[a]);
    fs.writeFileSync(indexPath, JSON.stringify(index));
    resetSessionScanIndexForTests();
    assert.deepEqual(await listSessionsIncremental(), expected, label);
    const sessions = await listAllSessions({ force: true });
    assert.deepEqual(sessions.map((s) => s.id), expected.map((s) => s.id), label);
    flushSessionScanIndexForTests();
    resetSessionScanIndexForTests();
    assert.deepEqual(await listSessionsIncremental(), expected, `${label}: repaired cache survives restart`);
  }
  for (const source of ["{", "null", '{"version":3,"entries":{}}', '{"version":1,"entries":{}}', '{"version":2,"entries":[]}', '{"version":2,"entries":{"broken":null}}']) {
    fs.writeFileSync(indexPath, source);
    resetSessionScanIndexForTests();
    assert.deepEqual(await listSessionsIncremental(), expected, source);
  }
});

test("retains SDK handling of partial lines, activity timestamps, and empty sessions", async (t) => {
  const { dir, write } = fixture(t);
  const a = write("a", [
    message("a1", "assistant", "not the first user message"),
    message("a2", "user", []),
    { ...message("a3", "user", "user message"), message: { role: "user", content: "user message", timestamp: Date.parse("2026-01-04T00:00:00.000Z") } },
  ]);
  fs.appendFileSync(a, '{"unfinished":');
  const b = write("b");
  fs.writeFileSync(b, "\nnot json\n" + fs.readFileSync(b, "utf8"));
  fs.writeFileSync(join(dir, "invalid.jsonl"), line(message("invalid", "user", "no header")));
  assert.deepEqual(await listSessionsIncremental(), await sdkMetadata());
});

test("stores only a bounded first-message preview in the session index", async (t) => {
  const { write, indexPath } = fixture(t);
  write("long", [message("u1", "user", "x".repeat(10_000))]);

  const [session] = await listSessionsIncremental();
  assert.equal(session.firstMessage, "x".repeat(500));

  flushSessionScanIndexForTests();
  const persisted = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  assert.equal(persisted.version, 6);
  assert.equal(Object.values(persisted.entries)[0].info.firstMessage.length, 500);
  assert.equal(Object.values(persisted.entries)[0].resume.state.firstMessage.length, 500);
});

test("uses a direct image result as the session preview", async (t) => {
  const { write } = fixture(t);
  write("image", [{
    type: "custom_message",
    id: "image-1",
    parentId: null,
    timestamp,
    customType: "pi-image-result",
    content: "Generated image: .. .pi/generated-images/image.png",
    display: true,
    details: { prompt: "A three-layer architecture diagram" },
  }]);

  const [session] = await listSessionsIncremental();
  assert.equal(session.messageCount, 1);
  assert.equal(session.firstMessage, "A three-layer architecture diagram");
});

test("rebuilds an old index without changing the full session message", async (t) => {
  const { root, write, indexPath } = fixture(t);
  const fullMessage = "x".repeat(10_000);
  const path = write("legacy", [message("u1", "user", fullMessage)]);
  const stats = fs.statSync(path);
  fs.writeFileSync(indexPath, JSON.stringify({
    version: 1,
    entries: {
      [path]: {
        fp: { size: stats.size, mtimeMs: stats.mtimeMs },
        info: {
          path,
          id: "legacy",
          cwd: root,
          created: timestamp,
          modified: timestamp,
          messageCount: 1,
          firstMessage: fullMessage,
        },
      },
    },
  }));
  resetSessionScanIndexForTests();

  const [session] = await listSessionsIncremental();
  assert.equal(session.firstMessage, "x".repeat(500));
  assert.equal(JSON.parse(fs.readFileSync(path, "utf8").trim().split("\n")[1]).message.content, fullMessage);

  flushSessionScanIndexForTests();
  assert.equal(JSON.parse(fs.readFileSync(indexPath, "utf8")).version, 6);
  resetSessionScanIndexForTests();
  const [restored] = await listSessionsIncremental();
  assert.equal(restored.firstMessage, "x".repeat(500));
});

test("discovers sessions through project directory symlinks", { skip: process.platform === "win32" }, async (t) => {
  const { root, dir, write } = fixture(t);
  write("a", [message("a1", "user", "linked")]);
  const external = join(root, "external-project");
  fs.renameSync(dir, external);
  fs.symlinkSync(external, dir, "dir");
  assert.deepEqual(await listSessionsIncremental(), await sdkMetadata());
});

test("a file that keeps failing to scan does not rewrite the index on every pass", async (t) => {
  const { write, dir, indexPath } = fixture(t);
  write("valid", [message("u1", "user", "hello")]);
  fs.writeFileSync(join(dir, "broken.jsonl"), "not a session\n");

  assert.equal((await listSessionsIncremental()).length, 1);
  flushSessionScanIndexForTests();
  assert.ok(fs.existsSync(indexPath), "the first pass indexes the valid session");
  fs.rmSync(indexPath);

  assert.equal((await listSessionsIncremental()).length, 1);
  flushSessionScanIndexForTests();
  assert.equal(fs.existsSync(indexPath), false, "nothing changed, so nothing is written");

  write("second", [message("u2", "user", "again")]);
  assert.equal((await listSessionsIncremental()).length, 2);
  flushSessionScanIndexForTests();
  assert.ok(fs.existsSync(indexPath), "a real change is persisted");
});

async function checkScanStart(path, start, label) {
  const expected = await scanSessionFileInfo(path);
  reads.length = 0;
  const actual = await listSessionsIncremental();
  assert.deepEqual(actual, expected ? [expected] : [], label);
  assert.deepEqual(reads, [{ path, start }], `${label}: scan start`);
  return actual[0];
}

const imageResult = (prompt, time = timestamp) => ({
  type: "custom_message", customType: "pi-image-result", timestamp: time, details: { prompt },
});

test("append resumes with the same counts, names, previews and activity as a full scan", async (t) => {
  const { write } = fixture(t);
  const path = write("growing");
  await listSessionsIncremental();
  async function append(entry, label) {
    const start = fs.statSync(path).size;
    fs.appendFileSync(path, line(entry));
    return checkScanStart(path, start, label);
  }
  let row = await append(message("a", "assistant", "reply", "2026-01-04T00:00:00.000Z"), "assistant-only start");
  assert.equal(row.firstMessage, "(no messages)");
  row = await append(imageResult("", "2026-01-05T00:00:00.000Z"), "empty image prompt");
  assert.equal(row.firstMessage, "(no messages)");
  row = await append(message("u", "user", [{ type: "image", data: "ignored" }]), "image-only user message");
  assert.equal(row.firstMessage, "(no messages)");
  const skill = `<skill name="review" location="/tmp/SKILL.md">\nReferences are relative to /tmp.\n\n${"body".repeat(2000)}\n</skill>\n\nsrc/main.ts`;
  row = await append(message("u2", "user", skill), "skill preview before truncation");
  assert.equal(row.firstMessage, "/skill:review src/main.ts");
  row = await append(imageResult("must not replace the first preview", "2026-01-06T00:00:00.000Z"), "image count and activity");
  assert.equal(row.messageCount, 5);
  assert.equal(row.modified.toISOString(), "2026-01-06T00:00:00.000Z");
  row = await append(message("tool", "toolResult", "output", "2026-01-09T00:00:00.000Z"), "tool result counts but is not activity");
  assert.equal(row.messageCount, 6);
  assert.equal(row.modified.toISOString(), "2026-01-06T00:00:00.000Z");
  row = await append({ type: "session_info", name: "  Named  " }, "rename");
  assert.equal(row.name, "Named");
  row = await append({ type: "session_info", name: " " }, "clear name");
  assert.equal(row.name, undefined);
  flushSessionScanIndexForTests();
  resetSessionScanIndexForTests();
  row = await append({ ...message("u3", "user", "later"), message: { role: "user", content: "later", timestamp: Date.parse("2026-01-07T00:00:00.000Z") } }, "persisted resume state");
  assert.equal(row.messageCount, 7);
  assert.equal(row.firstMessage, "/skill:review src/main.ts");
  assert.equal(row.modified.toISOString(), "2026-01-07T00:00:00.000Z");
});

test("an appended image result supplies the first preview and remains first after restart", async (t) => {
  const { write } = fixture(t);
  const path = write("image-resume");
  await listSessionsIncremental();
  let start = fs.statSync(path).size;
  fs.appendFileSync(path, line(imageResult("x".repeat(499) + "😀tail", "2026-01-03T00:00:00.000Z")));
  let row = await checkScanStart(path, start, "image first");
  assert.equal(row.messageCount, 1);
  assert.equal(row.firstMessage, "x".repeat(499));
  flushSessionScanIndexForTests();
  resetSessionScanIndexForTests();
  start = fs.statSync(path).size;
  fs.appendFileSync(path, line(message("u", "user", "later user message")));
  row = await checkScanStart(path, start, "image preview persisted");
  assert.equal(row.firstMessage, "x".repeat(499));
  assert.equal(row.messageCount, 2);
  assert.equal(row.modified.toISOString(), "2026-01-03T00:00:00.000Z");
});

test("partial UTF-8 lines resume from their start, including across index reloads", async (t) => {
  const { write, indexPath } = fixture(t);
  const path = write("partial");
  await listSessionsIncremental();
  const start = fs.statSync(path).size;
  const bytes = Buffer.from(line(message("u", "user", "hello 😀 world")));
  const cut = bytes.indexOf(Buffer.from("😀")) + 2;
  fs.appendFileSync(path, bytes.subarray(0, cut));
  let row = await checkScanStart(path, start, "partial UTF-8");
  assert.equal(row.messageCount, 0);
  flushSessionScanIndexForTests();
  const saved = JSON.parse(fs.readFileSync(indexPath, "utf8")).entries[path];
  assert.equal(saved.resume.offset, start);
  assert.equal(saved.resume.state.messageCount, 0);
  resetSessionScanIndexForTests();
  fs.appendFileSync(path, bytes.subarray(cut));
  row = await checkScanStart(path, start, "finished UTF-8");
  assert.equal(row.messageCount, 1);
  assert.equal(row.firstMessage, "hello 😀 world");

  const next = fs.statSync(path).size;
  fs.appendFileSync(path, JSON.stringify(message("a", "assistant", "no newline", "2026-01-04T00:00:00.000Z")));
  row = await checkScanStart(path, next, "valid unterminated JSON still displays");
  assert.equal(row.messageCount, 2);
  flushSessionScanIndexForTests();
  assert.equal(JSON.parse(fs.readFileSync(indexPath, "utf8")).entries[path].resume.state.messageCount, 1);
  resetSessionScanIndexForTests();
  fs.appendFileSync(path, "\n" + line({ type: "session_info", name: "done" }));
  row = await checkScanStart(path, next, "newline does not double-count");
  assert.equal(row.messageCount, 2);
  assert.equal(row.name, "done");
});

test("unterminated first messages and renames display without changing checkpoint totals", async (t) => {
  const { write } = fixture(t);
  const path = write("last-json");
  await listSessionsIncremental();
  let start = fs.statSync(path).size;
  fs.appendFileSync(path, JSON.stringify(message("u", "user", "first without newline")));
  let row = await checkScanStart(path, start, "unterminated first message");
  assert.equal(row.firstMessage, "first without newline");
  flushSessionScanIndexForTests();
  resetSessionScanIndexForTests();
  fs.appendFileSync(path, "\n" + JSON.stringify({ type: "session_info", name: "temporary" }));
  row = await checkScanStart(path, start, "first message completed, unterminated rename");
  assert.equal(row.messageCount, 1);
  assert.equal(row.name, "temporary");
  flushSessionScanIndexForTests();
  resetSessionScanIndexForTests();
  start = fs.readFileSync(path).lastIndexOf(0x0a) + 1;
  fs.appendFileSync(path, "\n" + line(message("a", "assistant", "reply")));
  row = await checkScanStart(path, start, "rename completed without losing the first preview");
  assert.equal(row.name, "temporary");
  assert.equal(row.firstMessage, "first without newline");
  assert.equal(row.messageCount, 2);
});

test("resumes CRLF, lone CR and chunk-spanning lines without corrupting UTF-8", async (t) => {
  const { write } = fixture(t);
  const path = write("line-ends");
  await listSessionsIncremental();
  let start = fs.statSync(path).size;
  fs.appendFileSync(path, JSON.stringify(message("u", "user", "x".repeat(70_000) + "😀")) + "\r");
  let row = await checkScanStart(path, start, "large lone-CR line");
  assert.equal(row.messageCount, 1);
  start = fs.statSync(path).size;
  fs.appendFileSync(path, "\n" + JSON.stringify(message("a", "assistant", "answer")) + "\r\n" + JSON.stringify({ type: "session_info", name: "CRLF" }) + "\r");
  row = await checkScanStart(path, start, "CRLF across polls");
  assert.equal(row.messageCount, 2);
  assert.equal(row.name, "CRLF");
});

test("truncate, same-size rewrite, head rewrite and tail rewrite force full scans", async (t) => {
  const { write } = fixture(t);
  const entries = [message("u", "user", "question"), { type: "custom", data: "x".repeat(8_000) }, message("a", "assistant", "answer")];
  const path = write("rewrite", entries, { parentSession: "/old/parent.jsonl" });
  await listSessionsIncremental();
  // The tail stays identical at the old offset; only the head sample changes.
  const before = fs.statSync(path);
  write("rewrite", entries, { parentSession: "/new/parent.jsonl" });
  fs.appendFileSync(path, line(message("a2", "assistant", "appended")));
  assert.equal(fs.statSync(path).ino, before.ino);
  let row = await checkScanStart(path, 0, "header reparent plus growth");
  assert.equal(row.parentSessionPath, "/new/parent.jsonl");

  const source = fs.readFileSync(path, "utf8");
  fs.writeFileSync(path, source.replace('"id":"a2"', '"id":"z2"'));
  fs.appendFileSync(path, line(message("a3", "assistant", "more")));
  await checkScanStart(path, 0, "tail sample changed plus growth");

  const modified = fs.statSync(path).mtimeMs;
  fs.writeFileSync(path, fs.readFileSync(path, "utf8").replace("question", "replaced"));
  fs.utimesSync(path, new Date(modified + 1000), new Date(modified + 1000));
  row = await checkScanStart(path, 0, "same size rewrite");
  assert.equal(row.firstMessage, "replaced");

  write("rewrite", [message("only", "user", "truncated")]);
  row = await checkScanStart(path, 0, "truncate");
  assert.equal(row.messageCount, 1);
  assert.equal(row.firstMessage, "truncated");
});

for (const resumed of [false, true]) {
  test(`a rewrite after ${resumed ? "resumed" : "full"} stream read cannot bind old state to new samples`, async (t) => {
    const { write } = fixture(t);
    t.after(() => { onReadEnd = undefined; });
    const padding = { type: "custom", data: "x".repeat(8_000) };
    const user = message("u", "user", "original");
    // Exercise a changed tail on a cold scan and a changed cached head on resume.
    const path = write("read-race", resumed ? [user, padding] : [padding, user]);
    if (resumed) {
      await listSessionsIncremental();
      fs.appendFileSync(path, line(message("a", "assistant", "new tail")));
    }
    const before = fs.statSync(path);
    const source = fs.readFileSync(path, "utf8");
    let rewritten = false;
    onReadEnd = (file) => {
      if (file !== path) return;
      onReadEnd = undefined;
      fs.writeFileSync(path, source.replace("original", "replaced"));
      // A metadata-only check must not hide the stale-sample regression.
      fs.utimesSync(path, before.atime, before.mtime);
      rewritten = true;
    };
    const [snapshot] = await listSessionsIncremental();
    assert.ok(rewritten, "rewrite ran after the read but before checkpoint creation");
    assert.equal(fs.statSync(path).ino, before.ino, "rewrite keeps the inode");
    assert.equal(snapshot.firstMessage, "original", "this scan parsed the old bytes");
    flushSessionScanIndexForTests();
    resetSessionScanIndexForTests();
    fs.appendFileSync(path, line(message("next", "assistant", "another append")));
    const row = await checkScanStart(path, 0, "rewritten samples reject the old checkpoint");
    assert.equal(row.firstMessage, "replaced");
  });
}

test("headers outside the bounded head sample stay on full scans", async (t) => {
  const { write } = fixture(t);
  const entries = [message("u", "user", "request"), { type: "custom", data: "x".repeat(4_000) }];
  const path = write("long-header", entries, { cwd: "/" + "x".repeat(2_000), parentSession: "/old/parent.jsonl" });
  await listSessionsIncremental();
  write("long-header", entries, { cwd: "/" + "x".repeat(2_000), parentSession: "/new/parent.jsonl" });
  fs.appendFileSync(path, line(message("a", "assistant", "tail")));
  const row = await checkScanStart(path, 0, "long header reparent");
  assert.equal(row.parentSessionPath, "/new/parent.jsonl");
});

test("new inode forces a full scan even with matching samples or size/mtime", async (t) => {
  const { write, dir } = fixture(t);
  const path = write("replace", [
    { type: "custom", data: "x".repeat(4_000) },
    message("u", "user", "original"),
    { type: "custom", data: "x".repeat(4_000) },
  ]);
  for (const append of [true, false]) {
    await listSessionsIncremental();
    const before = fs.statSync(path);
    const temp = join(dir, "replacement.tmp");
    fs.writeFileSync(temp, fs.readFileSync(path, "utf8").replace(append ? "original" : "replaced", append ? "replaced" : "original"));
    fs.renameSync(temp, path);
    assert.notEqual(fs.statSync(path).ino, before.ino);
    if (append) fs.appendFileSync(path, line(message("a", "assistant", "appended")));
    else fs.utimesSync(path, before.atime, before.mtime);
    const row = await checkScanStart(path, 0, append ? "replaced and appended" : "same-size replacement");
    assert.equal(row.firstMessage, append ? "replaced" : "original");
  }
});

test("device mismatch rejects persisted resume state", async (t) => {
  const { write, indexPath } = fixture(t);
  const path = write("device", [message("u", "user", "request")]);
  await listSessionsIncremental();
  flushSessionScanIndexForTests();
  const saved = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  saved.entries[path].fp.dev++;
  fs.writeFileSync(indexPath, JSON.stringify(saved));
  resetSessionScanIndexForTests();
  fs.appendFileSync(path, line(message("a", "assistant", "answer")));
  await checkScanStart(path, 0, "different device");
});

test("version 2 index is rebuilt once, then its checkpoint can resume", async (t) => {
  const { write, indexPath } = fixture(t);
  const path = write("upgrade", [message("u", "user", "real request")]);
  await listSessionsIncremental();
  flushSessionScanIndexForTests();
  const old = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  old.version = 2;
  old.entries[path].info.firstMessage = "stale preview";
  old.entries[path].info.messageCount = 9000;
  delete old.entries[path].resume;
  fs.writeFileSync(indexPath, JSON.stringify(old));
  resetSessionScanIndexForTests();
  const row = await checkScanStart(path, 0, "version upgrade");
  assert.equal(row.firstMessage, "real request");
  assert.equal(row.messageCount, 1);
  flushSessionScanIndexForTests();
  assert.equal(JSON.parse(fs.readFileSync(indexPath, "utf8")).version, 6);
  resetSessionScanIndexForTests();
  const start = fs.statSync(path).size;
  fs.appendFileSync(path, line(message("a", "assistant", "new tail")));
  await checkScanStart(path, start, "upgraded checkpoint");
});

test("index writes coalesce for five seconds without delaying the in-memory result", async (t) => {
  const { write, indexPath } = fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const path = write("throttle", [message("u", "user", "one")]);
  await listSessionsIncremental();
  assert.equal(fs.existsSync(indexPath), false);
  t.mock.timers.tick(4_000);
  fs.appendFileSync(path, line(message("a", "assistant", "two")));
  assert.equal((await listSessionsIncremental())[0].messageCount, 2);
  t.mock.timers.tick(999);
  assert.equal(fs.existsSync(indexPath), false);
  t.mock.timers.tick(1);
  assert.equal(JSON.parse(fs.readFileSync(indexPath, "utf8")).entries[path].info.messageCount, 2);
  fs.appendFileSync(path, line(message("a2", "assistant", "three")));
  await listSessionsIncremental();
  assert.equal(JSON.parse(fs.readFileSync(indexPath, "utf8")).entries[path].info.messageCount, 2);
  t.mock.timers.tick(5_000);
  assert.equal(JSON.parse(fs.readFileSync(indexPath, "utf8")).entries[path].info.messageCount, 3);
});

test("concurrent scans keep their captured directory, index, ordering and queued save", async (t) => {
  const { write, root, indexPath } = fixture(t);
  const a = write("a", [message("u1", "user", "newer file")]);
  const z = write("z", [message("u2", "user", "older file")]);
  fs.utimesSync(a, new Date("2026-02-02"), new Date("2026-02-02"));
  fs.utimesSync(z, new Date("2026-02-01"), new Date("2026-02-01"));
  const other = fs.mkdtempSync(join(tmpdir(), "pi-web-scanner-concurrent-"));
  t.after(() => {
    readdirHook = undefined;
    fs.rmSync(other, { recursive: true, force: true });
  });
  const otherDir = join(other, "sessions", "project");
  const otherPath = join(otherDir, "other.jsonl");
  const otherIndex = join(other, "pi-web-session-index.json");
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(otherPath, line({ type: "session", id: "other", cwd: other, timestamp }));

  const paused = Promise.withResolvers();
  const release = Promise.withResolvers();
  readdirHook = async (path, ...args) => {
    if (path === join(root, "sessions")) {
      paused.resolve();
      await release.promise;
    }
    return readdir(path, ...args);
  };
  const first = listSessionsIncremental();
  await paused.promise;
  process.env.PI_CODING_AGENT_DIR = other;
  let secondRows;
  try {
    secondRows = await listSessionsIncremental();
  } finally {
    release.resolve();
  }
  const firstRows = await first;
  readdirHook = undefined;
  assert.deepEqual(secondRows.map((row) => row.path), [otherPath]);
  assert.deepEqual(firstRows.map((row) => row.path), [a, z], "mtime tie ordering uses the first scan's map");
  assert.deepEqual([...globalThis.__piSessionMembership.files], [otherPath], "the late scan does not overwrite the active directory's membership");
  flushSessionScanIndexForTests();
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(indexPath, "utf8")).entries).sort(), [a, z].sort());
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(otherIndex, "utf8")).entries), [otherPath]);
  reads.length = 0;
  assert.deepEqual(await listSessionsIncremental(), secondRows);
  assert.deepEqual(reads, [], "the second directory's in-memory cache was not changed by the first scan");
});

test("queued saves retain their agent directory when the environment switches", async (t) => {
  const { write, root, indexPath } = fixture(t);
  const path = write("first", [message("u", "user", "first directory")]);
  const other = fs.mkdtempSync(join(tmpdir(), "pi-web-scanner-other-"));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const otherDir = join(other, "sessions", "project");
  fs.mkdirSync(otherDir, { recursive: true });
  const otherIndex = join(other, "pi-web-session-index.json");
  await listSessionsIncremental();
  process.env.PI_CODING_AGENT_DIR = other;
  flushSessionScanIndexForTests();
  assert.equal(fs.existsSync(otherIndex), false);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(indexPath, "utf8")).entries), [path]);
  process.env.PI_CODING_AGENT_DIR = root;
  fs.appendFileSync(path, line(message("a", "assistant", "second message")));
  await listSessionsIncremental();
  process.env.PI_CODING_AGENT_DIR = other;
  const otherPath = join(otherDir, "other.jsonl");
  fs.writeFileSync(otherPath, line({ type: "session", id: "other", cwd: other, timestamp }));
  await listSessionsIncremental();
  assert.equal(JSON.parse(fs.readFileSync(indexPath, "utf8")).entries[path].info.messageCount, 2);
  flushSessionScanIndexForTests();
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(otherIndex, "utf8")).entries), [otherPath]);
});

test("sessions a routine prompted carry the routine id; its own untouched chats are marked run-only", async (t) => {
  const { write } = fixture(t);
  const marker = (mode) => ({ type: "custom", id: "r1", parentId: null, timestamp, customType: "pi-web:routine-run", data: { version: 1, routineId: "rt", runId: "rt:x", ...(mode ? { mode } : {}) } });
  write("run-chat", [marker("new_session"), message("u1", "user", "scheduled prompt"), message("a1", "assistant", "done")]);
  write("continued-run", [marker("new_session"), message("u1", "user", "scheduled prompt"), message("u2", "user", "a follow-up I typed")]);
  write("same-chat", [marker("same_session"), message("u1", "user", "scheduled prompt")]);
  write("my-chat-reused", [message("u0", "user", "hello"), marker(), message("u1", "user", "scheduled prompt")]);
  write("plain-chat", [message("u1", "user", "hello")]);
  write("forked-run", [marker("new_session"), message("u1", "user", "scheduled prompt")], { parentSession: "/sessions/run-chat.jsonl" });
  const byId = Object.fromEntries((await listSessionsIncremental()).map((session) => [session.id, [session.routineId, session.routineRunOnly]]));
  assert.deepEqual(byId, {
    "run-chat": ["rt", true],
    "continued-run": ["rt", undefined],
    "same-chat": ["rt", undefined],
    "my-chat-reused": ["rt", undefined],
    "plain-chat": [undefined, undefined],
    "forked-run": ["rt", undefined],
  });
});
