import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

// Components take colors from the theme tokens in app/globals.css
// (--danger, --success, --warning, --accent, ...; tints via color-mix) so every
// theme recolors them. Allowed literals: black shadows/scrims and white.
// TerminalPanel owns a fixed ANSI palette; the HTML preview frame matches the
// standalone preview document served by app/api/files.
const root = new URL("..", import.meta.url).pathname;
const exempt = new Set(["TerminalPanel.tsx"]);
const allowed = /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,[^)]*\)|#fff(fff)?\b|#eef1f5|\(#\d+\)|#\d+\)|issue #\d+/gi;

test("components use theme tokens instead of hardcoded colors", async () => {
  const violations = [];
  for (const name of await readdir(join(root, "components"))) {
    if (!name.endsWith(".tsx") || exempt.has(name)) continue;
    const lines = (await readFile(join(root, "components", name), "utf8")).split("\n");
    lines.forEach((line, i) => {
      const rest = line.replace(allowed, "");
      const m = rest.match(/#[0-9a-f]{3,8}\b|rgba?\(/i);
      if (m) violations.push(`components/${name}:${i + 1} ${m[0]}`);
    });
  }
  assert.deepEqual(violations, []);
});
