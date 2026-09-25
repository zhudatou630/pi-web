import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { readPinnedSessionIds, setSessionPinned } = await jiti.import("./pinned-sessions.ts");

test("pins persist to a server-side file and toggle idempotently", () => {
  const path = join(mkdtempSync(join(tmpdir(), "pins-")), "pi-web", "pinned-sessions.json");
  assert.deepEqual(readPinnedSessionIds(path), []);
  setSessionPinned("a", true, path);
  setSessionPinned("b", true, path);
  setSessionPinned("a", true, path);
  assert.deepEqual(readPinnedSessionIds(path), ["b", "a"]);
  setSessionPinned("b", false, path);
  assert.deepEqual(readPinnedSessionIds(path), ["a"]);
});
