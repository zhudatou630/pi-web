import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("routines header has a back control that returns to chat", () => {
  const start = source.indexOf('{mainView === "routines" ? (');
  const end = source.indexOf(") : (<>", start);
  assert.notEqual(start, -1, "routines header branch not found");
  assert.notEqual(end, -1, "routines header branch end not found");
  const header = source.slice(start, end);
  assert.match(header, /onClick=\{closeRoutines\}/);
  assert.match(header, /routines\.backToChat/);
  assert.match(
    source,
    /const closeRoutines = useCallback\(\(\) => \{\s*setMainView\("chat"\);[\s\S]*?router\.replace\(selectedSessionId \? `\?session=/,
  );
});
