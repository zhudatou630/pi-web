import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { TurnFilesContext, TurnWrittenFiles } = await jiti.import("./TurnWrittenFiles.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function render(props, context = {}) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null,
      React.createElement(TurnFilesContext.Provider, { value: context }, React.createElement(TurnWrittenFiles, props))),
  );
}

const files = [{ filePath: "/repo/lib/auth/callback.ts" }, { filePath: "/repo/README.md" }];

test("shows one chip per file with its name; the full path is the tooltip", () => {
  const html = render({ files, cwd: "/repo" });
  assert.match(html, /title="\/repo\/lib\/auth\/callback\.ts"/);
  // Long names ellipsize inside the chip instead of widening it past a narrow pane.
  assert.match(html, /<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">callback\.ts<\/span>/);
  assert.match(html, /max-width:100%;min-width:0/);
  assert.match(html, /<span[^>]*>README\.md<\/span>/);
  assert.doesNotMatch(html, /turn-files-dir|Wrote/);
});

test("shows the folder only for names that collide", () => {
  const html = render({ files: [{ filePath: "/repo/a/index.ts" }, { filePath: "/repo/b/index.ts" }, { filePath: "/repo/c.ts" }], cwd: "/repo" });
  assert.match(html, /index\.ts <span class="turn-files-dir">a<\/span>/);
  assert.match(html, /index\.ts <span class="turn-files-dir">b<\/span>/);
  assert.equal(html.match(/turn-files-dir/g).length, 2);
  assert.match(html, /aria-label="Open a\/index\.ts"/);
});

test("only the last turn links to the Changes view", () => {
  assert.match(render({ files, cwd: "/repo", latest: true }, { onReview() {} }), /class="turn-files-review"[^>]*>Review/);
  assert.doesNotMatch(render({ files, cwd: "/repo" }, { onReview() {} }), /Review/);
});

test("folds files past the limit behind a +N chip", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ filePath: `/repo/f${i}.ts` }));
  const html = render({ files: many, cwd: "/repo" });
  assert.equal(html.match(/title="\/repo\/f\d\.ts"/g).length, 7);
  assert.match(html, /aria-label="Show 3 more files"[^>]*>.*\+3/);
  assert.equal(render({ files: many.slice(0, 8), cwd: "/repo" }).match(/title="\/repo\/f\d\.ts"/g).length, 8);
});

test("renders nothing when no files were written", () => {
  assert.equal(render({ files: [] }), "");
});
