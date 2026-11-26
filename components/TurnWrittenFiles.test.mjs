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

function render(props, context = { panelOpen: false }) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null,
      React.createElement(TurnFilesContext.Provider, { value: context }, React.createElement(TurnWrittenFiles, props))),
  );
}

const files = [{ filePath: "/repo/lib/auth/callback.ts" }, { filePath: "/repo/README.md" }];

test("lists each file's name and folder relative to the session cwd, without counts", () => {
  const html = render({ files, cwd: "/repo" });
  assert.match(html, /Wrote 2 files/);
  assert.match(html, /<span class="turn-files-name">callback\.ts<\/span><span class="turn-files-dir">lib\/auth<\/span>/);
  assert.match(html, /<span class="turn-files-name">README\.md<\/span><span class="turn-files-dir"><\/span>/);
  assert.match(html, /title="\/repo\/lib\/auth\/callback\.ts"/);
  assert.doesNotMatch(html, /[+−]\d/);
});

test("only the last turn's card says this turn and links to the Changes view", () => {
  const review = render({ files, cwd: "/repo", latest: true }, { panelOpen: false, onReview() {} });
  assert.match(review, /<button type="button" class="turn-files-head"[^>]*>.*This turn wrote 2 files.*Review/);
  const older = render({ files, cwd: "/repo" }, { panelOpen: false, onReview() {} });
  assert.match(older, /<div class="turn-files-head">Wrote 2 files<\/div>/);
  assert.doesNotMatch(older, /Review/);
});

test("folds to the title row while the file panel is open", () => {
  const html = render({ files, cwd: "/repo", latest: true }, { panelOpen: true, onReview() {} });
  assert.match(html, /This turn wrote 2 files/);
  assert.doesNotMatch(html, /turn-files-row/);
});

test("renders nothing when no files were written", () => {
  assert.equal(render({ files: [] }), "");
});
