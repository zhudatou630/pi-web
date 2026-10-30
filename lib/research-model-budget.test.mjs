import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { researchModelBudget, withResearchModelDeadline } = await createJiti(import.meta.url).import("./research-model-budget.ts");

test("research calls have inactivity limits and exactly one outer retry owner", () => {
  assert.deepEqual(researchModelBudget(), { timeoutMs: 240000, maxRetries: 0 });
  for (const value of [0, 601, 1.5, "240", NaN]) assert.throws(() => researchModelBudget(value));
});

test("real progress lets a request exceed its original timeout", async () => {
  const started = Date.now();
  const value = await withResearchModelDeadline(new AbortController().signal, 1, async options => {
    for (let i = 0; i < 4; i++) {
      await new Promise(resolve => setTimeout(resolve, 400));
      options.progress();
      assert.equal(options.signal.aborted, false);
    }
    return "complete after original deadline";
  });
  assert.equal(value, "complete after original deadline");
  assert.ok(Date.now() - started > 1000);
});

test("progress followed by silence still expires without hidden retries", async () => {
  await assert.rejects(withResearchModelDeadline(new AbortController().signal, 1, async options => {
    await new Promise(resolve => setTimeout(resolve, 300));
    options.progress();
    return await new Promise(() => {});
  }), /no output progress/);
});

test("the invocation receives its explicit deadline and successful requests settle normally", async () => {
  assert.equal(await withResearchModelDeadline(new AbortController().signal, 2, async options => {
    assert.equal(options.maxRetries, 0);
    assert.equal(options.timeoutMs, 2000);
    assert.equal(options.signal.aborted, false);
    return "completed";
  }), "completed");
});

test("a hung provider is bounded even when it fails to settle after abort", async () => {
  let signal;
  const started = Date.now();
  await assert.rejects(withResearchModelDeadline(new AbortController().signal, 1, async options => {
    signal = options.signal;
    return await new Promise(() => {});
  }), /deadline exceeded/);
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - started < 4000);
});

test("disconnect aborts the provider and an already aborted request never invokes it", async () => {
  const controller = new AbortController();
  const request = withResearchModelDeadline(controller.signal, 30, async () => await new Promise(() => {}));
  controller.abort(new Error("client disconnected"));
  await assert.rejects(request, /client disconnected/);
  await assert.rejects(withResearchModelDeadline(controller.signal, 30, () => assert.fail("must not start")), /client disconnected/);
});
