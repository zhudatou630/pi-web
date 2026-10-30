import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-security-route-")));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR);
const previousCache = globalThis.__piAllowedRootsCache;
const previousRoots = globalThis.__piAdditionalAllowedRoots;
delete globalThis.__piAllowedRootsCache;
delete globalThis.__piAdditionalAllowedRoots;
test.after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  globalThis.__piAllowedRootsCache = previousCache;
  globalThis.__piAdditionalAllowedRoots = previousRoots;
  fs.rmSync(base, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const { GET: files, POST: upload } = await jiti.import("./[...path]/route.ts");
const { GET: diff } = await jiti.import("../git/diff/route.ts");
const { GET: index } = await jiti.import("../file-index/route.ts");
const { getGitStatus } = await jiti.import("../../../lib/git-changes.ts");
const { allowFileRoot } = await jiti.import("../../../lib/file-access.ts");
const { isFilePathReferencedBySession } = await jiti.import("../../../lib/session-file-references.ts");
const { isApiRequestAllowed } = await jiti.import("../../../lib/request-security.ts");
const { NextRequest } = await jiti.import("next/server");

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
function fixture() {
  const root = fs.mkdtempSync(path.join(base, "repo-"));
  git(root, "init", "--quiet");
  allowFileRoot(root);
  return root;
}
function request(handler, pathname, query) {
  const url = new URL(`http://localhost${pathname}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return handler(new NextRequest(url));
}
test("upload preflight and writes authorize nested directories and reject traversal and symlink escapes", async () => {
  const root = fixture();
  const nested = path.join(root, "src", "deep");
  fs.mkdirSync(nested, { recursive: true });
  const outside = fs.mkdtempSync(path.join(base, "upload-outside-"));
  link(outside, path.join(root, "escape"));
  link(nested, path.join(root, "inside"));
  const existingFile = path.join(root, "file.txt");
  fs.writeFileSync(existingFile, "original");
  async function post(directory, type, fileName = "uploaded.txt") {
    const body = type === "upload-check" ? JSON.stringify({ fileNames: [fileName] }) : new FormData();
    if (body instanceof FormData) body.append("files", new File(["uploaded"], fileName));
    return upload(new NextRequest(`http://localhost/api/files/target?type=${type}`, {
      method: "POST", body,
      headers: { host: "localhost", ...(type === "upload-check" ? { "Content-Type": "application/json" } : {}) },
    }), { params: Promise.resolve({ path: [directory.replace(/^\/+/, "")] }) });
  }
  for (const type of ["upload-check", "upload"]) {
    for (const directory of [outside, path.join(root, "escape"), `${root}/src/../src/deep`, `${root}/escape/../src`]) {
      assert.equal((await post(directory, type)).status, 403, `${type}: ${directory}`);
    }
    assert.equal((await post(existingFile, type)).status, 400);
    assert.equal((await post(path.join(root, "missing"), type)).status, 404);
    if (type === "upload-check") assert.equal((await post(nested, type, "../bad.txt")).status, 400);
  }
  assert.equal((await post(nested, "upload-check")).status, 200);
  const written = await post(nested, "upload");
  assert.equal(written.status, 200);
  assert.deepEqual((await written.json()).uploaded, ["uploaded.txt"]);
  assert.equal(fs.readFileSync(path.join(nested, "uploaded.txt"), "utf8"), "uploaded");
  assert.equal(fs.existsSync(path.join(root, "uploaded.txt")), false);
  assert.equal(fs.existsSync(path.join(outside, "uploaded.txt")), false);
  assert.deepEqual((await (await post(nested, "upload-check")).json()).conflicts, ["uploaded.txt"]);
  assert.equal((await post(path.join(root, "inside"), "upload", "via-link.txt")).status, 200);
  assert.equal(fs.readFileSync(path.join(nested, "via-link.txt"), "utf8"), "uploaded");
});

const diffRequest = (cwd, filePath) => request(diff, "/api/git/diff", { cwd, path: filePath });
const link = (target, destination) => fs.symlinkSync(target, destination, process.platform === "win32" ? "junction" : "dir");

test("cross-site PDF navigation keeps file authorization and script-free response headers", async () => {
  const root = fixture();
  const outside = fs.mkdtempSync(path.join(base, "pdf-outside-"));
  const pdf = "%PDF-1.4\n%%EOF\n";
  for (const dir of [root, outside]) fs.writeFileSync(path.join(dir, "Paper.PDF"), pdf);
  link(outside, path.join(root, "escape"));
  async function read(filePath) {
    const req = new NextRequest(`http://localhost/api/files/${filePath.replace(/^\/+/, "")}?type=read`, {
      headers: { host: "localhost", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-user": "?1" },
    });
    assert.equal(isApiRequestAllowed(req), true, "the proxy allows only the navigation, not the file");
    return files(req, { params: Promise.resolve({ path: filePath.replace(/^\/+/, "").split("/") }) });
  }
  const response = await read(path.join(root, "Paper.PDF"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await response.text(), pdf);
  assert.equal((await read(path.join(outside, "Paper.PDF"))).status, 403);
  assert.equal((await read(path.join(root, "escape", "Paper.PDF"))).status, 403);
});

test("files and file-index refuse traversal, including the session-reference exception", async () => {
  const root = fixture();
  const outside = fs.mkdtempSync(path.join(base, "outside-"));
  link(outside, path.join(root, "linked"));
  for (const directory of [root, outside]) fs.writeFileSync(path.join(directory, "secret.txt"), "secret");
  const sessionId = "550e8400-e29b-41d4-a716-446655440000";
  const externalPath = `${outside}/linked/../secret.txt`;
  link(root, path.join(outside, "linked"));
  const sessions = path.join(process.env.PI_CODING_AGENT_DIR, "sessions", "fixture");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, `2026-01-01_${sessionId}.jsonl`), [
    { type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: root },
    { type: "message", id: "entry-1", parentId: null, message: { role: "user", content: externalPath } },
  ].map(JSON.stringify).join("\n") + "\n");
  assert.equal(await isFilePathReferencedBySession(externalPath, sessionId), true);
  for (const filePath of [`${root}/linked/../secret.txt`, externalPath]) {
    const response = await files(new NextRequest(`http://localhost/api/files/x?type=read&sessionId=${sessionId}`), {
      // One decoded catch-all segment can contain slashes from %2F.
      params: Promise.resolve({ path: [filePath.replace(/^\/+/, "")] }),
    });
    assert.equal(response.status, 403);
  }
  assert.equal((await request(index, "/api/file-index", { cwd: `${root}/linked/..` })).status, 403);
});

test("git target authorization refuses outside/dangling links and preserves deleted diffs", async () => {
  const root = fixture();
  const outside = fs.mkdtempSync(path.join(base, "diff-outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside secret\n");
  link(outside, path.join(root, "linked"));
  assert.equal((await diffRequest(root, path.join(root, "linked", "secret.txt"))).status, 403);
  const missing = path.join(root, "linked", "missing-parent", "missing.txt");
  assert.equal((await diffRequest(root, missing)).status, 403);
  fs.rmSync(outside, { recursive: true });
  assert.equal((await diffRequest(root, missing)).status, 403);
  assert.equal((await diffRequest(root, `${root}/unused/../missing.txt`)).status, 403);

  const child = path.join(root, "parent", "child");
  fs.mkdirSync(child, { recursive: true });
  const targets = [path.join(root, "deleted.txt"), path.join(child, "deleted.txt")];
  for (const file of targets) fs.writeFileSync(file, "tracked original\n");
  git(root, "add", "deleted.txt", "parent");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture");
  fs.unlinkSync(targets[0]);
  fs.rmSync(path.join(root, "parent"), { recursive: true });
  for (const file of targets) {
    const response = await diffRequest(root, file);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.supported, true);
    assert.equal(result.status, "deleted");
    assert.match(result.patch, /-tracked original/);
  }
  assert.deepEqual(await (await diffRequest(root, path.join(root, "absent", "file.txt"))).json(), { supported: false });
});

test("read-only file-index, status and diff never execute a repository fsmonitor hook", { skip: process.platform === "win32" }, async () => {
  const root = fixture();
  const file = path.join(root, "tracked.txt");
  fs.writeFileSync(file, "original\n");
  git(root, "add", ".");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture");
  fs.writeFileSync(file, "changed\n");
  const marker = path.join(base, "hook-ran");
  const hook = path.join(base, "fsmonitor-hook");
  fs.writeFileSync(hook, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdout.write('token\\0');\n`, { mode: 0o755 });
  git(root, "config", "core.fsmonitor", hook);
  git(root, "status", "--porcelain");
  assert.equal(fs.existsSync(marker), true, "fixture hook must actually execute");
  fs.unlinkSync(marker);
  assert.equal((await request(index, "/api/file-index", { cwd: root })).status, 200);
  assert.equal(fs.existsSync(marker), false);
  assert.equal((await getGitStatus(root)).isGitRepository, true);
  assert.equal(fs.existsSync(marker), false);
  assert.equal((await diffRequest(root, file)).status, 200);
  assert.equal(fs.existsSync(marker), false);
});
