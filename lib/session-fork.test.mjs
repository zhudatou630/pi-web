import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { forkSessionFile, SessionForkError } = await jiti.import("./session-fork.ts");
const source = await readFile(new URL("./session-fork.ts", import.meta.url), "utf8");

function assistant(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function texts(manager) {
  return manager.buildSessionContext().messages.map((message) => (
    typeof message.content === "string"
      ? message.content
      : message.content.map((block) => block.text ?? "").join("")
  ));
}

test("session fork copies the requested leaf and leaves the source file alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-session-fork-"));
  const sessionDir = join(root, "sessions");
  try {
    const manager = SessionManager.create(root, sessionDir);
    manager.appendMessage({ role: "user", content: "first prompt", timestamp: Date.now() });
    const firstUserId = manager.getLeafId();
    manager.appendMessage(assistant("first answer"));
    const firstAnswerId = manager.getLeafId();
    manager.branch(firstUserId);
    manager.appendMessage(assistant("other answer"));
    const sourceFile = manager.getSessionFile();
    const sourceId = manager.getSessionId();
    const sourceLeaf = manager.getLeafId();
    const before = await readFile(sourceFile, "utf8");

    const forked = forkSessionFile(sourceFile, firstAnswerId);
    const copy = SessionManager.open(forked.path, sessionDir);
    assert.equal(copy.getHeader().parentSession, sourceFile);
    assert.equal(copy.getHeader().id, forked.sessionId);
    assert.notEqual(forked.sessionId, sourceId);
    assert.equal(copy.getLeafId(), firstAnswerId);
    assert.deepEqual(texts(copy), ["first prompt", "first answer"]);
    assert.equal(await readFile(sourceFile, "utf8"), before);
    assert.equal(manager.getSessionId(), sourceId);
    assert.equal(manager.getLeafId(), sourceLeaf);

    const other = forkSessionFile(sourceFile);
    assert.deepEqual(texts(SessionManager.open(other.path, sessionDir)), ["first prompt", "other answer"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session fork accepts a user message before any assistant reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-session-fork-user-"));
  const sessionDir = join(root, "sessions");
  try {
    const manager = SessionManager.create(root, sessionDir);
    manager.appendMessage({ role: "user", content: "prompt only", timestamp: Date.now() });
    const forked = forkSessionFile(manager.getSessionFile());
    assert.deepEqual(texts(SessionManager.open(forked.path, sessionDir)), ["prompt only"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session fork refuses missing files, empty sessions, missing leaves, and subagents", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-session-fork-refuse-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  try {
    await assert.rejects(async () => forkSessionFile(join(root, "missing.jsonl")), (error) => {
      assert.ok(error instanceof SessionForkError);
      assert.equal(error.code, "not_found");
      return true;
    });

    const headerOnly = join(sessionDir, "header-only.jsonl");
    await writeFile(headerOnly, `${JSON.stringify({
      type: "session",
      version: 3,
      id: "header-only",
      timestamp: new Date().toISOString(),
      cwd: root,
    })}\n`);
    await assert.rejects(async () => forkSessionFile(headerOnly), (error) => {
      assert.equal(error.code, "empty");
      return true;
    });

    const named = SessionManager.create(join(root, "chat"), sessionDir);
    named.appendMessage({ role: "user", content: "keep", timestamp: Date.now() });
    await assert.rejects(async () => forkSessionFile(named.getSessionFile(), "missing-leaf"), (error) => {
      assert.equal(error.code, "invalid_leaf");
      return true;
    });

    const subagent = SessionManager.create(join(root, "sub"), sessionDir);
    subagent.appendMessage({ role: "user", content: "delegated", timestamp: Date.now() });
    subagent.appendCustomEntry("pi-web:subagent", {
      version: 1,
      parentSessionId: "parent",
      parentSessionPath: named.getSessionFile(),
    });
    await assert.rejects(async () => forkSessionFile(subagent.getSessionFile()), (error) => {
      assert.equal(error.code, "subagent");
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persisted fork refuses a busy runtime without touching the live wrapper", () => {
  assert.match(source, /isRpcSessionForkBlocked\(sessionId\)/);
  assert.match(source, /SessionManager\.open\(filePath\)/);
  assert.doesNotMatch(source, /inner\.sessionManager\.createBranchedSession|getRpcSession\(/);
});
