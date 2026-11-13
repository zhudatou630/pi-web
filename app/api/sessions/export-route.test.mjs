import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routeSrc = readFileSync(new URL("./[id]/export/route.ts", import.meta.url), "utf8");

test("HTML exports use a private per-request directory and clean all exporter output", () => {
  assert.match(routeSrc, /mkdtempSync\(join\(tmpdir\(\), "pi-web-export-"\)\)/);
  assert.doesNotMatch(routeSrc, /join\(tmpdir\(\), "pi-web-export"\)/);
  assert.match(routeSrc, /finally \{\s*rmSync\(tempDir, \{ recursive: true, force: true \}\)/);
  assert.ok(routeSrc.indexOf("format ===") < routeSrc.indexOf("const tempDir"));
});

test("markdown export is a current-branch download, not HTML inline", () => {
  assert.match(routeSrc, /format === "md" \|\| format === "markdown"/);
  assert.match(routeSrc, /searchParams\.get\("leafId"\)/);
  assert.match(routeSrc, /searchParams\.get\("tz"\)/);
  assert.match(routeSrc, /buildSessionMarkdown\(getSessionEntries\(filePath\), \{\s*leafId,\s*timezoneOffsetMinutes,[\s\S]*?\}\)/);
  assert.match(routeSrc, /Content-Type": "text\/markdown; charset=utf-8"/);
  assert.match(routeSrc, /getContentDisposition\(result\.fileName, false\)/);
  assert.match(routeSrc, /status: 422/);
});
