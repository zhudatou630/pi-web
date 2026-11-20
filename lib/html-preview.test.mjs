import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const {
  chooseHtmlPreviewRoot, createHtmlPreviewUrl, getHtmlPreviewMime, resolveHtmlPreviewPath,
} = await jiti.import("./html-preview.ts");
const { GET } = await jiti.import("../app/api/html-preview/[token]/[...path]/route.ts");
const { POST } = await jiti.import("../app/api/html-preview/route.ts");

function tempDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-html-preview-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function project(t) {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, "docs", "img"), { recursive: true });
  fs.mkdirSync(path.join(root, "assets"));
  fs.writeFileSync(path.join(root, "docs", "page one.html"), "<!doctype html><html><head><title>x</title></head><body><img src=\"img/a.png\"></body></html>");
  fs.writeFileSync(path.join(root, "docs", "img", "a.png"), "png");
  fs.writeFileSync(path.join(root, "assets", "b.css"), "body{}");
  return root;
}

function tokenAndSegments(url) {
  const [, , , token, ...segments] = url.split("/");
  return { token, segments: segments.map(decodeURIComponent) };
}

test("a grant serves files anywhere under its root and nothing outside it", (t) => {
  const root = project(t);
  const outside = tempDir(t);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "docs", "link.txt"));

  const url = createHtmlPreviewUrl(root, path.join(root, "docs", "page one.html"));
  assert.match(url, /^\/api\/html-preview\/[A-Za-z0-9_-]{32}\/docs\/page%20one\.html$/);
  const { token, segments } = tokenAndSegments(url);
  assert.deepEqual(segments, ["docs", "page one.html"]);

  assert.equal(resolveHtmlPreviewPath(token, segments), path.join(root, "docs", "page one.html"));
  assert.equal(resolveHtmlPreviewPath(token, ["docs", "img", "a.png"]), path.join(root, "docs", "img", "a.png"));
  assert.equal(resolveHtmlPreviewPath(token, ["assets", "b.css"]), path.join(root, "assets", "b.css"));
  assert.equal(resolveHtmlPreviewPath(token, ["docs", "link.txt"]), null, "symlink out of the root");
  assert.equal(resolveHtmlPreviewPath(token, ["docs", "..", "..", "etc"]), null);
  assert.equal(resolveHtmlPreviewPath(token, ["docs/../assets", "b.css"]), null);
  assert.equal(resolveHtmlPreviewPath(token, []), null);
  assert.equal(resolveHtmlPreviewPath(token, ["missing.png"]), null);
  assert.equal(resolveHtmlPreviewPath("A".repeat(32), segments), null);
  assert.throws(() => createHtmlPreviewUrl(path.join(root, "docs"), path.join(root, "assets", "b.css")));
});

test("a grant stays on the root it was issued for, even if that path becomes a symlink", (t) => {
  const parent = tempDir(t);
  const root = path.join(parent, "repo");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "x.html"), "<p>x</p>");
  const { token } = tokenAndSegments(createHtmlPreviewUrl(root, path.join(root, "x.html")));
  const elsewhere = path.join(parent, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, "secret.txt"), "secret");
  fs.renameSync(root, path.join(parent, "moved"));
  fs.symlinkSync(elsewhere, root);
  assert.equal(resolveHtmlPreviewPath(token, ["secret.txt"]), null);
});

test("a grant expires after an idle hour and each hit renews it", (t) => {
  const root = project(t);
  const now = 1_000_000;
  const { token, segments } = tokenAndSegments(createHtmlPreviewUrl(root, path.join(root, "docs", "page one.html"), now));
  const hour = 60 * 60 * 1000;
  assert.ok(resolveHtmlPreviewPath(token, segments, now + hour - 1));
  assert.ok(resolveHtmlPreviewPath(token, segments, now + 2 * hour - 2));
  assert.equal(resolveHtmlPreviewPath(token, segments, now + 3 * hour), null);
  assert.equal(resolveHtmlPreviewPath(token, segments, now), null, "an expired grant is gone");
});

test("the root is the git checkout when an allowed root covers it, else the narrowest allowed root", async (t) => {
  const parent = tempDir(t);
  const repo = path.join(parent, "repo");
  fs.mkdirSync(path.join(repo, "sub", "deep"), { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  const file = path.join(repo, "sub", "deep", "x.html");
  fs.writeFileSync(file, "<p>x</p>");

  assert.equal(await chooseHtmlPreviewRoot(file, new Set([repo])), repo);
  assert.equal(await chooseHtmlPreviewRoot(file, new Set([parent])), repo, "never wider than the checkout");
  assert.equal(await chooseHtmlPreviewRoot(file, new Set([path.join(repo, "sub")])), path.join(repo, "sub"));
  assert.equal(await chooseHtmlPreviewRoot(file, new Set([path.join(repo, "other")])), null);

  const plain = tempDir(t);
  fs.mkdirSync(path.join(plain, "a", "b"), { recursive: true });
  const plainFile = path.join(plain, "a", "b", "y.html");
  fs.writeFileSync(plainFile, "<p>y</p>");
  assert.equal(await chooseHtmlPreviewRoot(plainFile, new Set([plain, path.join(plain, "a")])), path.join(plain, "a"));
});

test("types come from the extension; unknown ones are never sniffed into something else", () => {
  assert.equal(getHtmlPreviewMime("a/x.HTML"), "text/html; charset=utf-8");
  assert.equal(getHtmlPreviewMime("x.png"), "image/png");
  assert.equal(getHtmlPreviewMime("x.woff2"), "font/woff2");
  assert.equal(getHtmlPreviewMime("x.mp4"), "video/mp4");
  assert.equal(getHtmlPreviewMime("x.constructor"), "application/octet-stream");
  assert.equal(getHtmlPreviewMime(".env"), "application/octet-stream");
});

test("the route serves the page with the storage polyfill and its files, all sandboxed", async (t) => {
  const root = project(t);
  const { token, segments } = tokenAndSegments(createHtmlPreviewUrl(root, path.join(root, "docs", "page one.html")));
  const get = (pathSegments) => GET(new Request(`http://localhost/api/html-preview/${token}/x`), {
    params: Promise.resolve({ token, path: pathSegments }),
  });

  const page = await get(segments);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(page.headers.get("content-security-policy"), "sandbox allow-scripts");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.equal(page.headers.get("access-control-allow-origin"), null);
  const html = await page.text();
  assert.match(html, /<head><script data-pi-web-polyfill="storage">/);
  assert.match(html, /<img src="img\/a\.png">/);

  const image = await get(["docs", "img", "a.png"]);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("content-security-policy"), "sandbox allow-scripts");
  assert.equal(image.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await image.text(), "png");

  assert.equal(image.headers.get("access-control-allow-origin"), null);
  fs.writeFileSync(path.join(root, "assets", "f.woff2"), "font");
  const font = await get(["assets", "f.woff2"]);
  assert.equal(font.headers.get("access-control-allow-origin"), "*", "@font-face loads need CORS");

  assert.equal((await get(["docs", "img"])).status, 404, "directories are not listed");
  assert.equal((await get(["nope.png"])).status, 404);
});

test("issuing a URL needs an HTML file inside an allowed root", async (t) => {
  const root = project(t);
  const outside = tempDir(t);
  fs.writeFileSync(path.join(outside, "z.html"), "<p>z</p>");
  const saved = globalThis.__piAllowedRootsCache;
  globalThis.__piAllowedRootsCache = { roots: new Set([root]), expiresAt: Date.now() + 60_000 };
  t.after(() => { globalThis.__piAllowedRootsCache = saved; });
  const post = (body) => POST(new Request("http://localhost/api/html-preview", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json", "sec-fetch-site": "same-origin", origin: "http://localhost" },
    body: JSON.stringify(body),
  }));

  const ok = await post({ path: path.join(root, "docs", "page one.html") });
  assert.equal(ok.status, 200);
  // A non-git temp dir: the narrowest allowed root, so `../assets` resolves too.
  const { token } = tokenAndSegments((await ok.json()).url);
  assert.equal(resolveHtmlPreviewPath(token, ["assets", "b.css"]), path.join(root, "assets", "b.css"));

  // A symlinked page keeps its own name and directory, as when opened from disk.
  fs.mkdirSync(path.join(root, "gen"));
  fs.writeFileSync(path.join(root, "gen", "output"), "<p>generated</p>");
  fs.symlinkSync(path.join(root, "gen", "output"), path.join(root, "docs", "report.html"));
  const alias = await post({ path: path.join(root, "docs", "report.html") });
  assert.equal(alias.status, 200);
  const aliasUrl = tokenAndSegments((await alias.json()).url);
  assert.deepEqual(aliasUrl.segments, ["docs", "report.html"]);
  assert.equal(resolveHtmlPreviewPath(aliasUrl.token, ["docs", "img", "a.png"]), path.join(root, "docs", "img", "a.png"));

  fs.symlinkSync(path.join(outside, "z.html"), path.join(root, "docs", "out.html"));
  assert.equal((await post({ path: path.join(root, "docs", "out.html") })).status, 403);
  assert.equal((await post({ path: path.join(outside, "z.html") })).status, 403);
  assert.equal((await post({ path: path.join(root, "assets", "b.css") })).status, 400);
  assert.equal((await post({ path: `${root}/docs/../docs/page one.html` })).status, 400);
  assert.equal((await post({ path: path.join(root, "docs", "missing.html") })).status, 403);
});
