import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useResizablePanel.ts", import.meta.url), "utf8");
const restore = source.slice(
  source.indexOf("useLayoutEffect(() => {"),
  source.indexOf("}, [commitWidth, defaultWidth, getDefaultWidth, storageKey]);"),
);

test("stored panel width is applied before paint without running CSS width transitions", () => {
  assert.match(restore, /panel\.style\.transition = "none"/);
  assert.match(restore, /commitWidth\(candidate, \{ persist: false \}\)/);
  assert.match(restore, /void panel\.offsetWidth/);
  assert.match(restore, /panel\.style\.transition = previousTransition/);
  assert.ok(restore.indexOf("transition = \"none\"") < restore.indexOf("commitWidth(candidate"));
  assert.ok(restore.indexOf("commitWidth(candidate") < restore.indexOf("void panel.offsetWidth"));
});
