import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { SubagentQueue } = await createJiti(import.meta.url).import("./subagent-queue.ts");

test("runs FIFO with a per-parent concurrency limit and drains after completion", async () => {
  const queue = new SubagentQueue();
  const events = [];
  let release;
  const first = queue.enqueue("parent", 1, () => new Promise((resolve) => { release = () => resolve("first"); }), (state) => events.push(["first", state]));
  const second = queue.enqueue("parent", 1, async () => "second", (state) => events.push(["second", state]));
  assert.deepEqual(events, [["first", "queued"], ["first", "running"], ["second", "queued"]]);
  release();
  assert.equal(await first.promise, "first");
  assert.equal(await second.promise, "second");
  assert.deepEqual(events, [
    ["first", "queued"], ["first", "running"], ["second", "queued"], ["second", "running"],
  ]);
});

test("cancels queued work without starting it", async () => {
  const queue = new SubagentQueue();
  let release;
  const first = queue.enqueue("parent", 1, () => new Promise((resolve) => { release = resolve; }), () => {});
  let started = false;
  let cancelled = false;
  const second = queue.enqueue("parent", 1, async () => { started = true; return "bad"; }, () => {}, () => { cancelled = true; });
  assert.equal(second.cancel(), true);
  assert.equal(cancelled, true);
  release();
  await first.promise;
  assert.equal(await second.promise, undefined);
  assert.equal(started, false);
});

test("a queued callback failure cannot leave orphan work in the queue", async () => {
  const queue = new SubagentQueue();
  let orphanRan = false;
  assert.throws(() => queue.enqueue("parent", 1, async () => { orphanRan = true; }, () => { throw new Error("disk full"); }), /disk full/);
  const next = queue.enqueue("parent", 1, async () => "next", () => {});
  assert.equal(await next.promise, "next");
  assert.equal(orphanRan, false);
});

test("a running callback failure rejects its item and lets the queue drain", async () => {
  const queue = new SubagentQueue();
  const broken = queue.enqueue("parent", 1, async () => assert.fail("must not run"), (state) => {
    if (state === "running") throw new Error("disk full");
  });
  await assert.rejects(broken.promise, /disk full/);
  assert.equal(await queue.enqueue("parent", 1, async () => "next", () => {}).promise, "next");
});

test("separate parents do not share the concurrency limit", async () => {
  const queue = new SubagentQueue();
  const running = [];
  let releaseA;
  let releaseB;
  queue.enqueue("a", 1, () => new Promise((resolve) => { running.push("a"); releaseA = resolve; }), () => {});
  queue.enqueue("b", 1, () => new Promise((resolve) => { running.push("b"); releaseB = resolve; }), () => {});
  assert.deepEqual(running, ["a", "b"]);
  releaseA("a");
  releaseB("b");
});
