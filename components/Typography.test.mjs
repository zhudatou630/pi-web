import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

// The UI ships exactly two faces, 400 and 600, no italic face, and disables
// font synthesis (see the @font-face rules in app/globals.css). Any other
// weight or a synthesized italic renders differently per machine and smears
// CJK. 600 is for headings only; state uses background/color/border instead.
const root = new URL("..", import.meta.url).pathname;

async function sourceLines() {
  const out = [];
  for (const dir of ["components", "app", "hooks", "lib"]) {
    const entries = await readdir(join(root, dir), { recursive: true, withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !/\.(tsx?|css)$/.test(e.name) || e.name.includes(".test.")) continue;
      const file = join(e.parentPath, e.name);
      const lines = (await readFile(file, "utf8")).split("\n");
      lines.forEach((line, i) => out.push({ where: `${file.slice(root.length)}:${i + 1}`, line, prev: lines.slice(Math.max(0, i - 3), i).join("\n") }));
    }
  }
  return out;
}

const lines = await sourceLines();

test("UI uses only font weights 400 and 600, never as a state toggle", () => {
  const violations = [];
  for (const { where, line } of lines) {
    for (const m of line.matchAll(/font-weight:\s*([^;}"]+)/g)) {
      if (!/^(400|600)(\s*!important)?\s*$/.test(m[1])) violations.push(`${where} font-weight: ${m[1].trim()}`);
    }
    for (const m of line.matchAll(/fontWeight:\s*([^,}\n]+)/g)) {
      if (!/^(400|600)\s*$/.test(m[1])) violations.push(`${where} fontWeight: ${m[1].trim()}`);
    }
    for (const m of line.matchAll(/\bfont-(thin|extralight|light|medium|bold|extrabold|black)\b/g)) {
      violations.push(`${where} ${m[0]}`);
    }
  }
  assert.deepEqual(violations, []);
});

test("text tiers hit the same contrast targets in light and dark themes", async () => {
  const css = await readFile(join(root, "app/globals.css"), "utf8");
  const block = (selector) => css.match(new RegExp(`^${selector} \\{([\\s\\S]*?)^\\}`, "m"))[1];
  const token = (body, name) => body.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))[1];
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  for (const selector of [":root", "html\\.dark"]) {
    const body = block(selector);
    const panel = token(body, "bg-panel");
    const at = (name) => ratio(token(body, name), panel);
    assert.ok(at("text") >= 12, `${selector} --text ${at("text")}`);
    assert.ok(at("text-muted") >= 8.5 && at("text-muted") <= 9.5, `${selector} --text-muted ${at("text-muted")}`);
    assert.ok(at("text-dim") >= 5.5 && at("text-dim") <= 6.5, `${selector} --text-dim ${at("text-dim")}`);
  }
});

// Size scale: 10 badges, 11 metadata, 12 UI body and section headings,
// 13 dense reading content (code, terminal, tables), 14 titles and chat body,
// 16 special (login input, device code), 20 glyphs.
// Chat-relative sizes are calc(<11..14>px + var(--chat-font-size-offset)).
// Markdown's relative em sizes are out of scope.
test("font sizes stay on the shared scale", () => {
  const scale = new Set([10, 11, 12, 13, 14, 16, 20]);
  const violations = [];
  for (const { where, line } of lines) {
    const found = [
      ...[...line.matchAll(/font-size:\s*(?:calc\()?(\d+(?:\.\d+)?)px/g)].map((m) => m[1]),
      ...[...line.matchAll(/fontSize:\s*"?(?:calc\()?(\d+(?:\.\d+)?)(?:px)?[",}\s+]/g)].map((m) => m[1]),
      ...[...line.matchAll(/\btext-\[(\d+(?:\.\d+)?)px\]/g)].map((m) => m[1]),
    ];
    for (const v of found) if (!scale.has(Number(v))) violations.push(`${where} ${v}px`);
  }
  assert.deepEqual(violations, []);
});

// A tier color with a permanent opacity is a fourth, unmeasured gray. Opacity
// that toggles back to 1 is a state (disabled, streaming, loading) and is fine.
test("text tier colors are never permanently dimmed with opacity", async () => {
  const violations = [];
  const tierColor = /color:\s*[^;,}]*var\(--text(-muted|-dim)?\)/;
  const faded = (b) => {
    const m = b.match(/opacity:\s*([^;,}\n]+)/);
    if (!m) return false;
    const values = [...m[1].matchAll(/(?<![\w.])(\d*\.?\d+)(?![\w.])/g)].map((v) => Number(v[1]));
    // opacity: 0 hides (reveal-on-hover), it does not create a gray.
    return values.length > 0 && values.every((v) => v < 1) && values.some((v) => v > 0);
  };
  for (const dir of ["components", "app"]) {
    const entries = await readdir(join(root, dir), { recursive: true, withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || e.name.includes(".test.") || !/\.(tsx|css)$/.test(e.name)) continue;
      const file = join(e.parentPath, e.name);
      const text = await readFile(file, "utf8");
      const blocks = e.name.endsWith(".css")
        ? [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => !/disabled|@keyframes|%|chevron|icon/.test(m[1])).map((m) => m[0])
        : [...text.matchAll(/[sS]tyle=\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]);
      for (const b of blocks) {
        if (tierColor.test(b) && faded(b)) violations.push(`${file.slice(root.length)}: ${b.replace(/\s+/g, " ").trim().slice(0, 120)}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("UI never uses italic; only markdown emphasis may request it", () => {
  const violations = lines
    .filter(({ line, prev }) => (/font-style:\s*italic|fontStyle:[^,}]*"italic"|className=[^>]*\bitalic\b/.test(line))
      && !(/font-style:\s*italic/.test(line) && /\.markdown-body em \{/.test(prev)))
    .map(({ where, line }) => `${where} ${line.trim()}`);
  assert.deepEqual(violations, []);
});
