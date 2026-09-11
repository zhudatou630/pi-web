import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { GeneratedImageResult, PendingGeneratedImage } = await jiti.import("./GeneratedImageResult.tsx");

const details = {
  type: "pi-image-result",
  version: 1,
  path: ".pi/generated-images/image.png",
  mimeType: "image/png",
  width: 1024,
  height: 1024,
  prompt: "A blue square",
  connection: "studio",
  model: "fixture-image",
  size: "1:1",
  resolution: "1k",
  quality: "auto",
};

function render(value) {
  return renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(GeneratedImageResult, { value, cwd: "/project", onEdit() {} }),
  ));
}

test("generated image results render saved originals and downloads", () => {
  const html = render(details);
  assert.match(html, /type=read/);
  assert.match(html, /type=download/);
  assert.match(html, /1:1 · 1K · Auto/);
  assert.match(html, />Edit</);
  assert.match(html, /1024 \/ 1024/);
  assert.doesNotMatch(html, /fixture-image/);
  assert.doesNotMatch(html, /files.mention|Mention|提及/);
});

test("generated image results can mention the saved file", () => {
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(GeneratedImageResult, { value: details, cwd: "/project", onMention() {} }),
  ));
  assert.match(html, /aria-label="Quote"/);
});

test("direct image results caption the prompt under the picture", () => {
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(GeneratedImageResult, { value: details, cwd: "/project", showPrompt: true }),
  ));
  assert.match(html, />A blue square</);
  assert.doesNotMatch(html, /--user-bg/);
});

test("pending image generation occupies the result slot", () => {
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(PendingGeneratedImage, { prompt: "A blue square", size: "4:3" }),
  ));
  assert.match(html, /Generating/);
  assert.match(html, /A blue square/);
  assert.match(html, /4 \/ 3/);
  assert.match(html, /image-pending-sheen/);
  assert.doesNotMatch(html, />Generating/);
  assert.doesNotMatch(html, /animate-pulse/);
});

test("incomplete image details do not create a result card", () => {
  const html = render({ type: "pi-image-result", version: 1 });
  assert.equal(html, "");
});