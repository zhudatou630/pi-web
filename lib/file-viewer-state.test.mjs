import assert from "node:assert/strict";
import test from "node:test";

import { createJiti } from "jiti";

const { defaultWrapLines, resolveInitialFileDisplayMode } = await createJiti(import.meta.url).import("./file-viewer-state.ts");

test("a restored display mode wins over a stale open hint", () => {
  const state = {
    displayMode: "source",
    wrapLines: true,
    scrollTop: 80,
    scrollLeft: 0,
  };

  assert.equal(resolveInitialFileDisplayMode(state, "diff"), "source");
});

test("the open hint is used only before viewer state has been saved", () => {
  assert.equal(resolveInitialFileDisplayMode(undefined, "diff"), "diff");
  assert.equal(resolveInitialFileDisplayMode(), "source");
  assert.equal(resolveInitialFileDisplayMode(undefined, "preview"), "preview");
});

test("prose files wrap by default; code and logs do not", () => {
  for (const path of ["/a/README.md", "/a/notes.TXT", "/a/doc.mdx", "/a/guide.rst", "C:\\a\\spec.adoc"]) assert.equal(defaultWrapLines(path), true, path);
  for (const path of ["/a/app.ts", "/a/server.log", "/a/data.json", "/a/Makefile"]) assert.equal(defaultWrapLines(path), false, path);
});
