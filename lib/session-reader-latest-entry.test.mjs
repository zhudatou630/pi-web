import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSync, writeSync, closeSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { readLatestEntryIdFromFile } = await jiti.import("./session-reader.ts");

const HEADER = JSON.stringify({ type: "session", version: 3, id: "session-id", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" });

function entry(id, parentId = null) {
  return JSON.stringify({ id, parentId, type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: id } });
}

async function inTempFile(t, content) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-tail-probe-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "session.jsonl");
  await writeFile(path, content);
  return path;
}

test("returns the newest entry id, not the session header's session id", async (t) => {
  // The header carries the session id rather than an entry id, so a probe that
  // returned it would never match and would evict on every read.
  const path = await inTempFile(t, `${HEADER}\n${entry("e1")}\n${entry("e2", "e1")}\n`);
  assert.equal(readLatestEntryIdFromFile(path), "e2");
});

test("skips a torn trailing line left by a concurrent append", async (t) => {
  // appendFileSync is not atomic from a reader's perspective.
  const path = await inTempFile(t, `${HEADER}\n${entry("e1")}\n{"id":"e2","parentId":"e1","type":"mess`);
  assert.equal(readLatestEntryIdFromFile(path), "e1");
});

test("tolerates a trailing newline and blank lines", async (t) => {
  const path = await inTempFile(t, `${HEADER}\n${entry("e1")}\n\n\n`);
  assert.equal(readLatestEntryIdFromFile(path), "e1");
});

test("returns null for a missing file, an empty file, or a header-only file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-tail-probe-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.equal(readLatestEntryIdFromFile(join(dir, "absent.jsonl")), null);
  const empty = await inTempFile(t, "");
  assert.equal(readLatestEntryIdFromFile(empty), null);
  const headerOnly = await inTempFile(t, `${HEADER}\n`);
  assert.equal(readLatestEntryIdFromFile(headerOnly), null);
});

test("stays bounded: the newest entry is found far beyond the read window", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-tail-probe-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "big.jsonl");
  await writeFile(path, `${HEADER}\n${entry("old")}\n`);
  // Append a large body so the newest entry sits well past any bounded window.
  const filler = `${entry("filler")}\n`;
  await appendFile(path, filler.repeat(4000));
  await appendFile(path, `${entry("newest")}\n`);

  assert.equal(readLatestEntryIdFromFile(path), "newest");

  // A window too small to contain the newest complete line finds nothing rather
  // than a wrong id: the probe never guesses.
  assert.equal(readLatestEntryIdFromFile(path, 10), null);
});

test("reads CRLF files written on Windows", async (t) => {
  const path = await inTempFile(t, `${HEADER}\r\n${entry("e1")}\r\n${entry("e2", "e1")}\r\n`);
  assert.equal(readLatestEntryIdFromFile(path), "e2");
});

test("a partially written line inside the window does not mask an earlier entry", async (t) => {
  // Simulate a writer that flushed half a line into a file that already had one.
  const dir = await mkdtemp(join(tmpdir(), "pi-web-tail-probe-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "session.jsonl");
  await writeFile(path, `${HEADER}\n${entry("e1")}\n`);
  const fd = openSync(path, "a");
  try {
    writeSync(fd, '{"id":"e2","paren');
  } finally {
    closeSync(fd);
  }
  assert.equal(readLatestEntryIdFromFile(path), "e1");
});

test("a wrapper's own append is always known, so reads cannot evict in a loop", async (t) => {
  const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
  const dir = await mkdtemp(join(tmpdir(), "pi-web-tail-probe-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const manager = SessionManager.create(dir, dir);
  const entryIds = () => manager.getEntries().map((e) => e.id);
  const probe = () => readLatestEntryIdFromFile(manager.getSessionFile() ?? "");

  // A session is only persisted once an assistant message exists: before that the
  // manager buffers in memory and the probe correctly has no opinion.
  manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
  assert.equal(probe(), null, "an unflushed session has nothing on disk to compare");

  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: Date.now() });
  const firstFlush = entryIds().at(-1);
  assert.equal(probe(), firstFlush, "the flush must be visible to the probe");

  // Later entries are appended directly, so the wrapper always knows its own tail.
  manager.appendMessage({ role: "user", content: "again", timestamp: Date.now() });
  const second = entryIds().at(-1);
  const found = probe();
  assert.equal(found, second);
  assert.ok(entryIds().includes(found), "a self-append must always be found in the wrapper");
});

test("an entry appended by another process is unknown to the wrapper", async (t) => {
  const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
  const dir = await mkdtemp(join(tmpdir(), "pi-web-tail-probe-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: "user", content: "ours", timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: Date.now() });
  const known = manager.getEntries().map((e) => e.id);

  // Another pi process appends to the same file, as the TUI would.
  await appendFile(
    manager.getSessionFile() ?? "",
    `${JSON.stringify({ id: "external-1", parentId: known.at(-1), type: "message", timestamp: new Date().toISOString(), message: { role: "user", content: "from the TUI" } })}\n`,
  );

  const found = readLatestEntryIdFromFile(manager.getSessionFile() ?? "");
  assert.equal(found, "external-1");
  assert.ok(!known.includes(found), "the external entry must look unknown, triggering a rebuild");
});

test("an entry larger than the probe window is reported, not silently missed", async (t) => {
  const { probeLatestEntryId } = await jiti.import("./session-reader.ts");
  const dir = await mkdtemp(join(tmpdir(), "pi-web-tail-probe-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "huge.jsonl");

  // A single image-bearing tool result can dwarf the window. The newest line then
  // has no complete line inside it, and returning "unchanged" would leave a stale
  // wrapper in place — exactly the bug this probe exists to fix.
  const huge = JSON.stringify({
    id: "huge-1",
    parentId: "e1",
    type: "message",
    timestamp: "2026-01-01T00:00:02.000Z",
    message: { role: "toolResult", toolCallId: "t1", content: [{ type: "image", data: "A".repeat(200_000) }] },
  });
  await writeFile(path, `${HEADER}\n${entry("e1")}\n${huge}\n`);

  const probe = probeLatestEntryId(path);
  assert.equal(probe.entryId, null, "the newest line does not fit the window");
  assert.equal(probe.overlongLine, true, "the caller must be told the window could not answer");

  // A window big enough resolves it normally.
  const big = probeLatestEntryId(path, 512 * 1024);
  assert.equal(big.entryId, "huge-1");
  assert.equal(big.overlongLine, false);
});

test("a normal file never reports an overlong line", async (t) => {
  const { probeLatestEntryId } = await jiti.import("./session-reader.ts");
  const path = await inTempFile(t, `${HEADER}\n${entry("e1")}\n${entry("e2", "e1")}\n`);
  const probe = probeLatestEntryId(path);
  assert.equal(probe.entryId, "e2");
  assert.equal(probe.overlongLine, false);
});
