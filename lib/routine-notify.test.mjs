import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { routineNoticePayload } = await createJiti(import.meta.url).import("./routine-notify.ts");

const routine = { id: "r1", name: "Digest" };

test("routine notices: wording per language, one tag per routine, a click opens the chat or the routine", () => {
  const failed = routineNoticePayload({ routine, run: { sessionId: "s1", error: "Model request failed" }, kind: "failed" }, "en");
  assert.deepEqual(failed, { title: "Routine “Digest” failed", body: "Model request failed", url: "/?session=s1", tag: "pi-session-complete:s1" }, "replaces the chat's own completion push");

  const skipped = routineNoticePayload({ routine, run: { skipReason: "target_busy" }, kind: "skipped" }, "zh-CN");
  assert.equal(skipped.title, "定时任务「Digest」跳过了一次运行");
  assert.equal(skipped.body, "对话正忙");
  assert.equal(skipped.url, "/?routines=r1");

  assert.equal(routineNoticePayload({ routine, run: {}, kind: "timed_out" }, "fr").body, "Timed out");
  assert.equal(routineNoticePayload({ routine, run: {}, kind: "paused" }, "en").url, "/?routines=r1");
  assert.equal(routineNoticePayload({ routine, run: { sessionId: "s1" }, kind: "timed_out" }, "en").tag, "pi-routine:r1");
});
