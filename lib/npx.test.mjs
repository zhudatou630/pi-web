import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createJiti } from "jiti";
import ts from "typescript";

const environment = await createJiti(import.meta.url).import("./project-command-env.ts");
const require = createRequire(import.meta.url);
const source = readFileSync(new URL("./npx.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });

test("npx sanitizes the host environment for both executable paths without using a shell", async () => {
  for (const hasCli of [true, false]) {
    let received;
    const exports = {};
    runInNewContext(outputText, { exports, process: { env: {
      PORT: "30141", NODE_ENV: "production", NEXT_RUNTIME: "nodejs", PI_WEB_PASSWORD: "secret",
      HTTPS_PROXY: "http://proxy", PATH: process.env.PATH, FORCE_COLOR: "1",
    } }, require(id) {
      if (id === "./project-command-env") return environment;
      if (id === "fs") return { existsSync: () => hasCli };
      if (id === "child_process") return { execFile(command, args, options, callback) {
        received = { command, args, options };
        callback(null, { stdout: "ok", stderr: "" });
      } };
      return require(id);
    } });
    await exports.runNpx(["skills", "find", "literal ; query"], { cwd: "/project", timeout: 123 });
    assert.deepEqual({ ...received.options.env }, {
      HTTPS_PROXY: "http://proxy", PATH: process.env.PATH, FORCE_COLOR: "0",
    });
    assert.equal(received.options.cwd, "/project");
    assert.equal(received.options.timeout, 123);
    assert.equal(received.options.shell, undefined);
    assert.deepEqual(Array.from(received.args).slice(-3), ["skills", "find", "literal ; query"]);
  }
});
