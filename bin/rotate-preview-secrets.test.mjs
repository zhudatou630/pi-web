import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import { PRERENDER_MANIFEST, rotatePreviewSecrets, getRotationError } from "./rotate-preview-secrets.js";

const require = createRequire(import.meta.url);
const preview = { previewModeId: "published-id", previewModeSigningKey: "published-signing", previewModeEncryptionKey: "published-encryption" };
function fixture(t, manifest = { version: 4, routes: { "/x": {} }, preview }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-rotate-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (manifest !== undefined) fs.writeFileSync(path.join(dir, PRERENDER_MANIFEST), JSON.stringify(manifest));
  return dir;
}
function read(dir) { return JSON.parse(fs.readFileSync(path.join(dir, PRERENDER_MANIFEST), "utf8")); }

test("rotates three secrets every time, preserving the manifest and cleaning temp files", (t) => {
  const dir = fixture(t);
  assert.deepEqual(rotatePreviewSecrets(dir), { ok: true });
  const first = read(dir);
  for (const [key, length] of [["previewModeId", 32], ["previewModeSigningKey", 64], ["previewModeEncryptionKey", 64]]) {
    assert.match(first.preview[key], new RegExp(`^[a-f0-9]{${length}}$`));
    assert.notEqual(first.preview[key], preview[key]);
  }
  assert.equal(first.version, 4);
  assert.deepEqual(first.routes, { "/x": {} });
  assert.deepEqual(rotatePreviewSecrets(dir), { ok: true });
  for (const key of Object.keys(preview)) assert.notEqual(read(dir).preview[key], first.preview[key]);
  assert.deepEqual(fs.readdirSync(dir), [PRERENDER_MANIFEST]);
});

test("missing, malformed and odd manifests fail closed", (t) => {
  const dir = fixture(t);
  fs.rmSync(path.join(dir, PRERENDER_MANIFEST));
  assert.equal(rotatePreviewSecrets(dir).reason, "missing");
  fs.writeFileSync(path.join(dir, PRERENDER_MANIFEST), "{bad json");
  assert.equal(rotatePreviewSecrets(dir).reason, "unreadable");
  for (const manifest of [null, [], {}, { preview: null }, { preview: [] }, { preview: {} }]) {
    fs.writeFileSync(path.join(dir, PRERENDER_MANIFEST), JSON.stringify(manifest));
    assert.deepEqual(rotatePreviewSecrets(dir), { ok: false, reason: "unexpected-shape" });
  }
  assert.match(getRotationError("missing"), /refusing to start.*manifest is missing/);
  assert.match(getRotationError("unwritable"), /not writable[\s\S]*x-prerender-revalidate/);
});

test("read-only install leaves the published manifest untouched", (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("file modes do not restrict this user/platform");
  const dir = fixture(t);
  fs.chmodSync(dir, 0o500);
  try {
    assert.equal(rotatePreviewSecrets(dir).reason, "unwritable");
    assert.deepEqual(read(dir).preview, preview);
  } finally { fs.chmodSync(dir, 0o700); }
});

function launcher(results) {
  const children = [], events = [], errors = [], exits = [];
  const parent = Object.assign(new EventEmitter(), {
    versions: process.versions, execPath: process.execPath, env: {}, exit: (code) => exits.push(code),
  });
  const customRequire = Object.assign((id) => {
    if (id === "./node-version") return { isNodeVersionSupported: () => true };
    if (id === "./pi-web-options") return { parseLaunchOptions: () => ({ port: "32123", hostname: "localhost", openBrowser: false }) };
    if (id === "./app-update") return { getGlobalNpmCli: () => ({ npmCli: "/npm.js" }) };
    if (id === "./process-lifecycle") return require("./process-lifecycle.js");
    if (id === "./rotate-preview-secrets") return { getRotationError, rotatePreviewSecrets: () => { events.push("rotate"); return results.shift(); } };
    if (id === "fs") return { existsSync: () => true };
    if (id === "child_process") return { spawn: (_exe, args) => {
      events.push(args[1] === "start" ? "next" : "install");
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill() {} });
      children.push(child);
      return child;
    } };
    return require(id);
  }, { resolve: () => "/next.js" });
  vm.runInNewContext(fs.readFileSync(new URL("./pi-web.js", import.meta.url), "utf8"), {
    require: customRequire, process: parent, __dirname: "/pkg/bin", setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error: (msg) => errors.push(msg) },
  });
  return { children, events, exits, errors };
}

test("every Next spawn after update or fallback is preceded by rotation", () => {
  for (const updateFails of [false, true]) {
    const state = launcher([{ ok: true }, { ok: true }]);
    state.children[0].emit("message", { type: "pi-web:update" });
    state.children[0].emit("exit", 0, null);
    state.children[1].emit("exit", updateFails ? 1 : 0, null);
    if (updateFails) state.children[2].emit("exit", 1, null);
    assert.deepEqual(state.events, ["rotate", "next", "install", ...(updateFails ? ["install"] : []), "rotate", "next"]);
    state.children.at(-1).emit("exit", 0, null);
  }
});

test("rotation failure refuses initial start and post-update restart", () => {
  for (const reason of ["missing", "unexpected-shape", "unwritable", "unreadable"]) {
    const initial = launcher([{ ok: false, reason }]);
    assert.equal(initial.children.length, 0);
    assert.deepEqual(initial.exits, [1]);
    assert.match(initial.errors[0], /refusing to start/);
    const restart = launcher([{ ok: true }, { ok: false, reason }]);
    restart.children[0].emit("message", { type: "pi-web:update" });
    restart.children[0].emit("exit", 0, null);
    restart.children[1].emit("exit", 0, null);
    assert.deepEqual(restart.events, ["rotate", "next", "install", "rotate"]);
    assert.deepEqual(restart.exits, [1]);
  }
});
