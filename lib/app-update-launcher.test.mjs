import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import { getGlobalNpmCli } from "../bin/app-update.js";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../bin/pi-web.js", import.meta.url), "utf8");

function launcher(canUpdate = true) {
  const children = [];
  const exits = [];
  const logs = [];
  const parent = Object.assign(new EventEmitter(), {
    versions: process.versions, execPath: process.execPath,
    env: { PI_WEB_PASSWORD: "test-password" },
    exit: (code) => exits.push(code),
  });
  const customRequire = Object.assign((name) => {
    if (name === "./node-version") return { isNodeVersionSupported: () => true };
    if (name === "./pi-web-options") return {
      parseLaunchOptions: () => ({ port: "32123", hostname: "127.0.0.1", openBrowser: false }),
    };
    if (name === "./app-update") return { getGlobalNpmCli: () => canUpdate ? "/npm-cli.js" : undefined };
    if (name === "./process-lifecycle") return require("../bin/process-lifecycle.js");
    if (name === "fs") return { existsSync: () => true };
    if (name === "child_process") return {
      spawn: (executable, args, options) => {
        const child = Object.assign(new EventEmitter(), {
          pid: children.length + 1, stdout: new EventEmitter(), signals: [],
          kill(signal) { this.signals.push(signal); },
          executable, args, options,
        });
        children.push(child);
        return child;
      },
    };
    return require(name);
  }, { resolve: () => "/next-cli.js" });
  vm.runInNewContext(source, {
    require: customRequire, process: parent, __dirname: "/pkg/bin",
    console: { log: (...args) => logs.push(args.join(" ")), warn() {}, error: (...args) => logs.push(args.join(" ")) },
    setTimeout, clearTimeout,
  });
  return { children, exits, logs, parent };
}

test("update stops Next before npm, ignores duplicates, then restarts with the same settings", () => {
  const { children, exits } = launcher();
  const original = children[0];
  original.emit("message", { type: "pi-web:update" });
  original.emit("message", { type: "pi-web:update" });
  assert.deepEqual(original.signals, ["SIGTERM"]);
  assert.equal(children.length, 1, "must not overwrite files while Next is alive");
  original.emit("exit", 143, null);
  const installer = children[1];
  assert.deepEqual([...installer.args], ["/npm-cli.js", "install", "-g", "@calmabacus/pi-web@latest"]);
  installer.emit("exit", 0, null);
  assert.equal(children.length, 3);
  assert.deepEqual(children[2].args, original.args);
  assert.deepEqual(children[2].options.env, original.options.env);
  assert.equal(children[2].options.env.PI_WEB_PASSWORD, "test-password");
  assert.deepEqual(exits, []);
  children[2].emit("exit", 0, null);
});

test("failed installation leaves recovery instructions and does not restart", () => {
  const { children, logs, parent } = launcher();
  children[0].emit("message", { type: "pi-web:update" });
  children[0].emit("exit", 143, null);
  children[1].emit("exit", 1, null);
  assert.equal(children.length, 2);
  assert.equal(parent.exitCode, 1);
  assert.ok(logs.some((line) => line.includes("npm install -g @calmabacus/pi-web@latest && pi-web")));
});

test("unsupported installs ignore update messages and user shutdown cancels a requested update", () => {
  const unsupported = launcher(false);
  unsupported.children[0].emit("message", { type: "pi-web:update" });
  assert.deepEqual(unsupported.children[0].signals, []);
  assert.equal(unsupported.children[0].options.env.PI_WEB_CAN_UPDATE, "0");
  unsupported.children[0].emit("exit", 0, null);
  const cancelled = launcher();
  cancelled.children[0].emit("message", { type: "pi-web:update" });
  cancelled.parent.emit("SIGINT");
  cancelled.children[0].emit("exit", 130, null);
  assert.equal(cancelled.children.length, 1);
  assert.deepEqual(cancelled.exits, [130]);
});

test("only the npm global install is eligible, excluding Git and managed services", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "pi-web-update-"));
  try {
    const root = path.join(temp, "global");
    const pkg = path.join(root, "@calmabacus", "pi-web");
    const npmCli = process.platform === "win32"
      ? path.join(temp, "node_modules", "npm", "bin", "npm-cli.js")
      : path.join(temp, "npm");
    mkdirSync(pkg, { recursive: true });
    mkdirSync(path.dirname(npmCli), { recursive: true });
    writeFileSync(npmCli, `console.log(${JSON.stringify(root)});`);
    const env = { ...process.env, PATH: temp, INVOCATION_ID: "", pm_id: "", PM2_HOME: "" };
    assert.equal(getGlobalNpmCli(pkg, env), npmCli);
    assert.equal(getGlobalNpmCli(temp, env), undefined);
    assert.equal(getGlobalNpmCli(pkg, { ...env, INVOCATION_ID: "service" }), undefined);
    assert.equal(getGlobalNpmCli(pkg, { ...env, pm_id: "0" }), undefined);
    mkdirSync(path.join(pkg, ".git"));
    assert.equal(getGlobalNpmCli(pkg, env), undefined);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
