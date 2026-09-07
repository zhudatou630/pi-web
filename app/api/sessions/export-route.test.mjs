import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routeSrc = readFileSync(new URL("./[id]/export/route.ts", import.meta.url), "utf8");

test("markdown export is a current-branch download, not HTML inline", () => {
  assert.match(routeSrc, /format === "md" \|\| format === "markdown"/);
  assert.match(routeSrc, /searchParams\.get\("leafId"\)/);
  assert.match(routeSrc, /buildSessionMarkdown\(getSessionEntries\(filePath\), \{ leafId \}\)/);
  assert.match(routeSrc, /Content-Type": "text\/markdown; charset=utf-8"/);
  assert.match(routeSrc, /getContentDisposition\(result\.fileName, false\)/);
  assert.match(routeSrc, /status: 422/);
});
