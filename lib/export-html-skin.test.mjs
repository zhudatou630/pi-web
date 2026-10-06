import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { EXPORT_SKIN_CSS, EXPORT_SKIN_SCRIPT, EXPORT_SKIN_VARS, skinExportHtml } from "./export-html-skin.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("all bundled font faces exactly match globals.css", () => {
  const faces = read("../app/globals.css").match(/@font-face\s*\{[^}]*\}/g);
  assert.equal(faces.length, 9);
  assert.equal(EXPORT_SKIN_CSS.match(/@font-face\s*\{/g).length, faces.length);
  for (const face of faces) assert.ok(EXPORT_SKIN_CSS.includes(face), face);
});

test("the synchronous click snapshots the same whitelist into the fragment", () => {
  const callback = read("../components/AppShell.tsx").split("const handleViewFullHistory = useCallback(() => {")[1].split("}, [selectedSession]);")[0];
  const keys = JSON.parse(callback.match(/const keys = (\[[\s\S]*?\]);/)[1].replace(/,\s*]/, "]"));
  assert.deepEqual(keys, EXPORT_SKIN_VARS);
  assert.match(callback, /getComputedStyle\(root\)/);
  assert.match(callback, /inline=1#\$\{encodeURIComponent\(JSON.stringify\(skin\)\)\}/);
  assert.doesNotMatch(callback, /\bawait\b/);
});

test("hash values go through CSSOM; unknown keys and invalid payloads are ignored", () => {
  const apply = (hash) => {
    const properties = new Map();
    const root = { dataset: {}, style: { setProperty: (key, value) => properties.set(key, value) } };
    runInNewContext(EXPORT_SKIN_SCRIPT, { location: { hash }, document: { documentElement: root } });
    return { root, properties };
  };
  const value = '</style><script>alert(1)</script>; --unknown: red';
  const { root, properties } = apply("#" + encodeURIComponent(JSON.stringify({
    vars: { bg: "#123456", text: value, unknown: "red", accent: 3, border: "" },
    dark: false, font: "wenkai",
  })));
  assert.deepEqual([...properties], [["--bg", "#123456"], ["--text", value]]);
  assert.equal(root.style.colorScheme, "light");
  assert.equal(root.dataset.font, "wenkai");
  const dark = apply("#" + encodeURIComponent(JSON.stringify({ vars: {}, dark: true, font: "invalid" })));
  assert.equal(dark.root.style.colorScheme, "dark");
  assert.equal(dark.root.dataset.font, undefined);
  for (const hash of ["", "#%broken", "#null", "#[]", "#{}", "#true"]) {
    assert.equal(apply(hash).properties.size, 0);
  }
});

test("skin is appended after template styles and tolerates upstream markup changes", () => {
  const html = skinExportHtml('<head><title>Session Export</title><style>original</style></head><body>tree</body>');
  assert.ok(html.indexOf('id="pi-web-export-skin"') > html.indexOf("original"));
  assert.match(html, /<title>Pi Web · Full history<\/title>/);
  assert.ok(html.includes(`<script>${EXPORT_SKIN_SCRIPT}</script>`));
  assert.equal(skinExportHtml("<body>changed template</body>"), "<body>changed template</body>");
});

test("export route retains all required deep-tree patches before applying the skin", () => {
  const route = read("../app/api/sessions/[id]/export/route.ts");
  const patch = route.slice(route.indexOf("function patchExportHtml("), route.indexOf("async function exportSession("))
    .replace("html: string", "html").replace("): string", ")")
    .replaceAll("source: string", "source").replaceAll("name: string", "name")
    .replaceAll("search: string", "search").replaceAll("replacement: string", "replacement")
    .replace("s: string", "s");
  const context = { skinExportHtml };
  runInNewContext(patch + "\nthis.patch = patchExportHtml;", context);
  const template = read("../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/template.html")
    .replace("{{JS}}", read("../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/template.js"));
  const html = context.patch(template);
  assert.ok(html.includes('id="pi-web-export-skin"'));
  assert.ok(!html.includes("node.children.forEach(sortChildren)"));
  assert.ok(!html.includes("node.children.forEach(mapNodes)"));
  assert.ok(!html.includes("if (markActive(child))"));
  assert.throws(() => context.patch("<head></head>"), /sortChildren expected 1 match/);
});
