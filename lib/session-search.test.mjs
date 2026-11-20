import assert from "node:assert/strict";
import fs, { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { createJiti } from "jiti";

let trackRead;
const createReadStream = fs.createReadStream;
mock.method(fs, "createReadStream", (path, ...args) => {
  trackRead?.(path);
  return createReadStream(path, ...args);
});
syncBuiltinESMExports();
const jiti = createJiti(import.meta.url);
const { searchSessionContents, sessionSearchTerms } = await jiti.import("./session-search.ts");
const { scanSessionFileInfo } = await jiti.import("./session-list-scanner.ts");

function fixture(t, entries, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-search-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return { id: "session", path, cwd: dir, created: "2026-01-01", modified: "2026-01-01", firstMessage: "first", messageCount: entries.length, ...overrides };
}

function message(role, content) {
  return { type: "message", message: { role, content } };
}

function trackReads(t) {
  const paths = [];
  trackRead = (path) => paths.push(path);
  t.after(() => { trackRead = undefined; });
  return paths;
}

test("terms AND across messages and display title, with a navigable first body hit", async (t) => {
  const session = fixture(t, [
    { ...message("user", "beta appears first"), id: "beta-entry" },
    message("assistant", "alpha later"),
  ], { name: "Project plan" });
  for (const query of ["alpha beta", "beta\u3000alpha", "alpha beta plan", "alpha alpha beta"]) {
    const result = await searchSessionContents([session], query);
    assert.equal(result.results.length, 1, query);
    assert.equal(result.results[0].entryId, "beta-entry");
    assert.equal(result.results[0].match, "beta");
  }
  assert.equal((await searchSessionContents([session], "alpha missing")).results.length, 0);
  assert.equal((await searchSessionContents([session], '"alpha beta"')).results.length, 0);
  assert.equal((await searchSessionContents([session], "alpha thinking")).results.length, 0);
});

test("quotes preserve exact phrases, embedded quotes and literal operators", async (t) => {
  assert.deepEqual(sessionSearchTerms('one "two three" four'), ["one", "two three", "four"]);
  assert.deepEqual(sessionSearchTerms('one "two three'), ["one", "two three"]);
  assert.deepEqual(sessionSearchTerms('foo"bar [a]+ ""'), ['foo"bar', "[a]+"]);
  assert.deepEqual(sessionSearchTerms('""'), ['""']);
  const session = fixture(t, [message("user", '中文 phrase with spaces foo"bar [a]+ ""')]);
  for (const query of ['中文 "phrase with spaces"', 'foo"bar [a]+', '""']) {
    assert.equal((await searchSessionContents([session], query)).results.length, 1, query);
  }
  assert.equal((await searchSessionContents([session], '"spaces with"')).results.length, 0);
});

test("finds one literal, case-insensitive snippet per session, newest first", async (t) => {
  const older = fixture(t, [{ ...message("user", "before NEEDLE after"), id: "matched-entry" }, message("user", "needle again")], { id: "older" });
  const newer = fixture(t, [message("assistant", [{ type: "text", text: "another needle" }])], { id: "newer", modified: "2026-02-01" });
  const result = await searchSessionContents([older, newer], " needle ");
  assert.deepEqual(result.results.map(({ session }) => session.id), ["newer", "older"]);
  assert.deepEqual(result.results[1], { session: older, entryId: "matched-entry", blockIndex: 0, before: "before ", match: "NEEDLE", after: " after" });
  assert.equal(result.truncated, false);

  const literal = fixture(t, [message("user", "a".repeat(40) + "!"), message("user", "literal (a+)+$ and [test].*")]);
  assert.equal((await searchSessionContents([literal], "(a+)+$")).results[0].match, "(a+)+$");
  assert.equal((await searchSessionContents([literal], "[test].*")).results[0].match, "[test].*");
});

test("assistant text matches as the chat shows it, without terminal escapes", async (t) => {
  const session = fixture(t, [{ ...message("assistant", [{ type: "text", text: "see \x1b[1mneed\x1b[22mle here" }]), id: "styled" }]);
  const [hit] = (await searchSessionContents([session], "needle")).results;
  assert.deepEqual([hit.entryId, hit.before, hit.match, hit.after], ["styled", "see ", "needle", " here"]);
});

test("title fallback uses the latest catalog name, without a message target", async (t) => {
  const session = fixture(t, [
    { type: "session", id: "session", cwd: "/project", timestamp: "2026-01-01" },
    message("user", "unrelated prompt"),
    { type: "session_info", name: "Old title" },
    { type: "session_info", name: "  Generated 中文 Planning  " },
  ]);
  const info = await scanSessionFileInfo(session.path);
  const catalog = { ...session, name: info.name, firstMessage: info.firstMessage };
  assert.deepEqual((await searchSessionContents([catalog], "中文 planning")).results, [{
    session: catalog, titleOnly: true, before: "Generated ", match: "中文", after: " Planning",
  }]);
  assert.deepEqual((await searchSessionContents([catalog], "Old title")).results, []);
  assert.deepEqual((await searchSessionContents([catalog], "cancelled", AbortSignal.abort())).results, []);

  const both = { ...catalog, name: "unrelated prompt" };
  const hits = (await searchSessionContents([both], "prompt")).results;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].titleOnly, undefined);
  assert.equal(hits[0].blockIndex, 0);
});

test("title fallback shares the sidebar's short preview and id fallback", async (t) => {
  const session = fixture(t, [], { firstMessage: "Visible title " + "x".repeat(60) + " hidden suffix" });
  assert.equal((await searchSessionContents([session], "visible")).results[0].titleOnly, true);
  assert.deepEqual((await searchSessionContents([session], "hidden suffix")).results, []);
  const unnamed = { ...session, firstMessage: "", id: "id-fallback-123456" };
  assert.equal((await searchSessionContents([unnamed], "id-fallback")).results[0].match, "id-fallback");
});

test("identifies the matching text block across thinking, tools and multiple text blocks", async (t) => {
  const session = fixture(t, [message("assistant", [
    { type: "thinking", thinking: "pi-cwd-spark" },
    { type: "text", text: "earlier text" },
    { type: "toolCall", name: "read", arguments: {} },
    { type: "text", text: "正文 pi-cwd-spark" },
    { type: "text", text: "later text" },
  ])]);
  assert.equal((await searchSessionContents([session], "pi-cwd-spark")).results[0].blockIndex, 3);
  assert.equal((await searchSessionContents([session], "earlier text")).results[0].blockIndex, 1);
  assert.equal((await searchSessionContents([session], "later text")).results[0].blockIndex, 4);
  assert.equal((await searchSessionContents([session], "spark\nlater")).results[0].blockIndex, 3);
});

test("searches historical text, excluding tools, thinking, images, summaries and transient sessions", async (t) => {
  const hidden = fixture(t, [
    message("toolResult", "needle"),
    message("assistant", [{ type: "thinking", thinking: "needle" }, { type: "toolCall", arguments: { text: "needle" } }, { type: "image", data: "needle" }]),
    { type: "compaction", summary: "needle" },
    { type: "custom", data: "needle" },
    message("user", null),
    null,
  ]);
  assert.deepEqual((await searchSessionContents([hidden], "needle")).results, []);
  const history = fixture(t, [message("user", "needle before compaction"), { type: "compaction", summary: "summary" }, message("user", "current")]);
  assert.equal((await searchSessionContents([history], "needle")).results.length, 1);
  assert.deepEqual((await searchSessionContents([{ ...history, transient: true }], "needle")).results, []);
});

test("keeps Unicode offsets correct and bounds snippets around the actual match", async (t) => {
  const session = fixture(t, [message("user", `${"x".repeat(200)}\n\u0130 中文 NEEDLE \n${"y".repeat(200)}`)]);
  const result = await searchSessionContents([session], "needle");
  assert.equal(result.results[0].match, "NEEDLE");
  assert.ok(result.results[0].before.startsWith("..."));
  assert.ok(result.results[0].after.endsWith("..."));
  assert.ok(result.results[0].before.length <= 83);
  assert.doesNotMatch(result.results[0].before, /\n/);
  assert.equal((await searchSessionContents([session], "中文")).results[0].match, "中文");
});

test("skips malformed lines and reports unreadable or oversized content as incomplete", async (t) => {
  const session = fixture(t, [message("user", "x".repeat(1024 * 1024 + 1)), message("user", "needle")]);
  const missing = { ...session, id: "missing", path: join(session.cwd, "missing.jsonl") };
  const result = await searchSessionContents([missing, session], "needle");
  assert.equal(result.results.length, 1);
  assert.equal(result.truncated, true);
  writeFileSync(session.path, `invalid\n${JSON.stringify(message("user", "needle"))}\n{"type":`);
  assert.equal((await searchSessionContents([session], "needle")).results.length, 1);
});

test("handles empty, oversized and cancelled queries without reading a session", async (t) => {
  const session = fixture(t, [message("user", "needle")]);
  assert.deepEqual(await searchSessionContents([session], "  "), { results: [], truncated: false });
  await assert.rejects(searchSessionContents([session], "x".repeat(201)), RangeError);
  assert.deepEqual(await searchSessionContents([session], "needle", AbortSignal.abort()), { results: [], truncated: true });
});

test("the byte cap prevents caching even when it falls on a line boundary", async (t) => {
  const reads = trackReads(t);
  const session = fixture(t, []);
  const line = JSON.stringify(message("user", "x".repeat(512 * 1024))) + "\n";
  const prefix = line.repeat(Math.floor(16 * 1024 * 1024 / line.length));
  const tail = (JSON.stringify(message("user", "")) + "\n").padStart(16 * 1024 * 1024 - prefix.length);
  writeFileSync(session.path, prefix + tail + JSON.stringify(message("user", "needle")));
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(await searchSessionContents([session], "needle"), { results: [], truncated: true });
  }
  assert.deepEqual(reads, [session.path, session.path]);
});

test("checks the deadline inside the final file and does not keep the interrupted scan", async (t) => {
  const reads = trackReads(t);
  const session = fixture(t, [message("user", "no match"), message("user", "needle")]);
  let ticks = 0;
  const clock = t.mock.method(Date, "now", () => ++ticks <= 3 ? 0 : 4000);
  assert.deepEqual(await searchSessionContents([session], "needle"), { results: [], truncated: true });
  clock.mock.restore();
  assert.equal((await searchSessionContents([session], "needle")).results.length, 1);
  assert.deepEqual(reads, [session.path, session.path]);
});

test("reports file and result caps even when no conversations match", async (t) => {
  const session = fixture(t, [message("user", "needle")]);
  const sessions = Array.from({ length: 501 }, (_, index) => ({ ...session, id: String(index) }));
  const noMatches = await searchSessionContents(sessions, "absent");
  assert.deepEqual(noMatches, { results: [], truncated: true });
  const capped = await searchSessionContents(sessions, "needle");
  assert.equal(capped.results.length, 30);
  assert.equal(capped.truncated, true);
  assert.equal((await searchSessionContents(sessions.slice(0, 30), "needle")).truncated, false);
});

test("a side chat is searched only after its last boundary, and by its own name", async (t) => {
  const boundary = { type: "custom_message", customType: "pi-web:side", content: "<side-chat>", display: false };
  const side = { relation: { kind: "side", parentSessionId: "main" }, firstMessage: "inherited question" };
  const inherited = fixture(t, [
    message("user", "inherited alpha"),
    boundary,
    { ...message("assistant", "own beta"), id: "own" },
  ], { ...side, name: "旁问：gamma" });
  assert.deepEqual((await searchSessionContents([inherited], "alpha")).results, []);
  assert.equal((await searchSessionContents([inherited], "beta")).results[0]?.entryId, "own");
  assert.equal((await searchSessionContents([inherited], "gamma beta")).results.length, 1, "name and own text AND together");
  assert.deepEqual((await searchSessionContents([inherited], "inherited")).results, [], "the inherited first message is not its title");

  // A nested side chat's copy holds its parent side chat's boundary and text too.
  const nested = fixture(t, [
    message("user", "main alpha"),
    boundary,
    message("assistant", "parent side beta"),
    boundary,
    message("assistant", "nested gamma"),
  ], { ...side, name: "Side chat" });
  assert.deepEqual((await searchSessionContents([nested], "beta")).results, []);
  assert.equal((await searchSessionContents([nested], "gamma")).results.length, 1);
  assert.deepEqual((await searchSessionContents([nested], "side chat")).results, [], "a placeholder name is app text");

  // Without a boundary nothing is its own, not even the name.
  const broken = fixture(t, [message("user", "alpha")], { ...side, name: "旁问：alpha" });
  assert.deepEqual((await searchSessionContents([broken], "alpha")).results, []);
  assert.deepEqual((await searchSessionContents([broken], "alpha")).results, [], "a cached side chat still needs a boundary");

  // Text that only mentions the boundary type is no boundary.
  const mention = fixture(t, [message("user", "about pi-web:side here"), message("assistant", "alpha")], { ...side, name: "旁问：x" });
  assert.deepEqual((await searchSessionContents([mention], "alpha")).results, []);
});

test("a side chat read only up to the byte budget confirms no match", async (t) => {
  const boundary = { type: "custom_message", customType: "pi-web:side", content: "<side-chat>", display: false };
  // The parent side chat's boundary and text fit in the budget; the nested chat's own boundary does not.
  const filler = message("assistant", "x".repeat(17 * 1024 * 1024));
  const session = fixture(t, [boundary, message("assistant", "parent side alpha"), filler, boundary, message("assistant", "own")],
    { relation: { kind: "side", parentSessionId: "main" }, name: "Side chat" });
  const result = await searchSessionContents([session], "alpha");
  assert.deepEqual(result.results, []);
  assert.equal(result.truncated, true);
});

test("reuses complete text with original navigation and post-ANSI snippets", async (t) => {
  const reads = trackReads(t);
  const session = fixture(t, [
    { ...message("assistant", [{ type: "thinking" }, { type: "text", text: "see \x1b[1mneed\x1b[22mle here" }]), id: "styled" },
    message("user", "beta is in a later message"),
  ], { name: "Release notes" });
  const query = "needle beta release";
  const cold = await searchSessionContents([session], query);
  assert.deepEqual(cold, { results: [{ session, entryId: "styled", blockIndex: 1, before: "see ", match: "needle", after: " here" }], truncated: false });
  await searchSessionContents([session], "absent");
  assert.deepEqual(await searchSessionContents([session], query), cold);
  assert.deepEqual(reads, [session.path, session.path]);
});

test("rereads after a size-only change or an mtime-only change", async (t) => {
  const reads = trackReads(t);
  const session = fixture(t, [message("user", "old text")]);
  const stamp = 1_600_000_000;
  utimesSync(session.path, stamp, stamp);
  await searchSessionContents([session], "absent");
  appendFileSync(session.path, JSON.stringify(message("user", "grown text")) + "\n");
  utimesSync(session.path, stamp, stamp);
  assert.equal((await searchSessionContents([session], "grown")).results.length, 1);

  await searchSessionContents([session], "absent");
  utimesSync(session.path, stamp + 1, stamp + 1);
  assert.equal((await searchSessionContents([session], "grown")).results.length, 1);
  assert.deepEqual(reads, Array(4).fill(session.path));
});

test("does not keep an early hit or a scan that skipped an oversized or malformed line", async (t) => {
  const reads = trackReads(t);
  const early = fixture(t, [message("user", "first"), message("user", "second")]);
  assert.equal((await searchSessionContents([early], "first")).results.length, 1);
  assert.equal((await searchSessionContents([early], "second")).results.length, 1);
  assert.deepEqual(reads.splice(0), [early.path, early.path]);

  const malformed = fixture(t, [message("user", "ok")]);
  appendFileSync(malformed.path, '{"type":');
  const oversized = fixture(t, [message("user", "x".repeat(1024 * 1024))]);
  for (const [session, truncated] of [[malformed, false], [oversized, true]]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual(await searchSessionContents([session], "absent"), { results: [], truncated });
    }
    assert.deepEqual(reads.splice(0), [session.path, session.path]);
  }
});

test("a side chat replays only its last segment, and changing read mode always misses", async (t) => {
  const reads = trackReads(t);
  const boundary = { type: "custom_message", customType: "pi-web:side" };
  const plain = fixture(t, [message("user", "inherited"), boundary, message("assistant", "parent segment"), boundary, message("user", "own words")], { name: "Side topic" });
  const side = { ...plain, relation: { kind: "side", parentSessionId: "parent" } };
  await searchSessionContents([plain], "absent");
  assert.deepEqual((await searchSessionContents([side], "inherited")).results, []);
  assert.deepEqual((await searchSessionContents([side], "parent segment")).results, []);
  assert.equal((await searchSessionContents([side], "topic own")).results.length, 1);
  assert.equal((await searchSessionContents([side], "topic")).results[0].titleOnly, true);
  assert.equal((await searchSessionContents([plain], "inherited")).results.length, 1);
  assert.deepEqual(reads, Array(3).fill(plain.path));
});

test("forgets cached transcripts outside the current search listing", async (t) => {
  const reads = trackReads(t);
  const session = fixture(t, [message("user", "needle")]);
  await searchSessionContents([session], "absent");
  await searchSessionContents([], "absent");
  assert.equal((await searchSessionContents([session], "needle")).results.length, 1);
  assert.deepEqual(reads, [session.path, session.path]);
});

test("an in-flight scan cannot restore a pruned transcript", async (t) => {
  const session = fixture(t, [message("user", "needle")]);
  let pruned;
  trackRead = () => { pruned = searchSessionContents([], "absent"); };
  await searchSessionContents([session], "absent");
  assert.ok(pruned);
  await pruned;

  const reads = trackReads(t);
  assert.equal((await searchSessionContents([session], "needle")).results.length, 1);
  assert.deepEqual(reads, [session.path]);
});

test("only evicts older cached text, and only if it frees enough space", async (t) => {
  const reads = trackReads(t);
  const line = message("user", "x".repeat(512 * 1024));
  const large = (mib, day) => fixture(t, Array(mib * 2).fill(line), { modified: `2026-01-0${day}` });
  const oldest = large(4, 1);
  const middle = large(8, 2);
  const newer = large(13, 3);
  const newest = large(13, 4);
  const fresh = large(8, 5);
  await searchSessionContents([oldest, newer, newest], "absent");
  assert.deepEqual(reads.splice(0), [newest.path, newer.path, oldest.path]);

  const window = [oldest, middle, newer, newest];
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(await searchSessionContents(window, "absent"), { results: [], truncated: false });
    assert.deepEqual(reads.splice(0), [middle.path]);
  }

  const expanded = [...window, fresh];
  await searchSessionContents(expanded, "absent");
  assert.deepEqual(reads.splice(0), [fresh.path, newer.path, middle.path, oldest.path]);
  await searchSessionContents(expanded, "absent");
  assert.deepEqual(reads, [newer.path, oldest.path]);
});
