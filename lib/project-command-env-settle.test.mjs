import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { createProjectCommandBashOperations } = await createJiti(import.meta.url).import("./project-command-env.ts");

for (const cause of ["abort", "pre-aborted", "timeout"]) {
  test(`hung bash settles after ${cause} grace and ignores a survivor's late output`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const controller = new AbortController();
    if (cause === "pre-aborted") controller.abort();
    let backendOptions;
    let finishBackend;
    const chunks = [];
    const operations = createProjectCommandBashOperations({
      baseEnvironment: {},
      localOperations: {
        exec(_command, _cwd, options) {
          backendOptions = options;
          return new Promise((_resolve, reject) => { finishBackend = reject; });
        },
      },
    });
    const command = operations.exec("surviving-child", "/tmp", {
      signal: controller.signal,
      ...(cause === "timeout" ? { timeout: 2 } : {}),
      onData: (data) => chunks.push(data),
    });
    let settled = false;
    const rejected = assert.rejects(command, cause === "timeout" ? /^Error: timeout:2$/ : /^Error: aborted$/).then(() => { settled = true; });
    if (cause === "abort") controller.abort();
    const deadline = cause === "timeout" ? 3_000 : 1_000;
    t.mock.timers.tick(deadline - 1);
    backendOptions.onData("last chunk");
    await Promise.resolve();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    await rejected;
    backendOptions.onData("survivor chunk");
    finishBackend(new Error("late backend rejection"));
    await Promise.resolve();
    assert.deepEqual(chunks, ["last chunk"]);
  });
}

test("normal SDK abort wins before grace; cleanup cancels the fallback timers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  let finishBackend;
  const operations = createProjectCommandBashOperations({
    baseEnvironment: {},
    localOperations: { exec: () => new Promise((resolve) => { finishBackend = resolve; }) },
  });
  const command = operations.exec("normal-child", "/tmp", { signal: controller.signal, timeout: 2, onData() {} });
  controller.abort();
  finishBackend({ exitCode: 137 });
  assert.deepEqual(await command, { exitCode: 137 });
  t.mock.timers.tick(10_000);
});
