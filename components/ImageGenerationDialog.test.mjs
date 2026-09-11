import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { ImageGenerationDialog } = await jiti.import("./ImageGenerationDialog.tsx");

function render(capabilities) {
  return renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(ImageGenerationDialog, {
      config: {
        defaultConnection: "studio",
        connections: [{ id: "studio", label: "Studio", provider: "xai", model: "image", capabilities }],
      },
      onClose() {},
      async onSubmit() {},
    }),
  ));
}

test("the direct image dialog exposes declared ratios, resolution, and quality", () => {
  const html = render({
    sizes: ["auto", "1:1", "9:16", "16:9"],
    resolutions: ["1k", "2k"],
    qualities: ["auto", "low", "medium"],
  });
  assert.doesNotMatch(html, />Studio</);
  assert.match(html, /Auto/);
  assert.match(html, /Square 1:1/);
  assert.match(html, /Portrait 9:16/);
  assert.match(html, /Landscape 16:9/);
  assert.match(html, /1K/);
  assert.match(html, /2K/);
  assert.match(html, /Low/);
  assert.match(html, /Medium/);
  assert.doesNotMatch(html, /1024x1536/);
  assert.doesNotMatch(html, /Choose target/);
  assert.doesNotMatch(html, /Add reference/);
});

test("the edit dialog binds the original image", () => {
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(ImageGenerationDialog, {
      config: {
        defaultConnection: "studio",
        connections: [{ id: "studio", label: "Studio", provider: "xai", model: "image", capabilities: { editing: true, sizes: ["auto"], qualities: ["medium"] } }],
      },
      edit: {
        type: "pi-image-result",
        version: 1,
        path: ".pi/generated-images/image.png",
        mimeType: "image/png",
        width: 1024,
        height: 1024,
        prompt: "A blue square",
        connection: "studio",
        model: "image",
      },
      editPreviewUrl: "/api/files/preview.png?type=read",
      onClose() {},
      async onSubmit() {},
    }),
  ));
  assert.match(html, /Edit image/);
  assert.match(html, /Describe the change/);
  assert.match(html, /preview.png/);
});

test("undeclared image options stay out of the direct dialog", () => {
  const html = render({});
  assert.doesNotMatch(html, /Choose target/);
  assert.doesNotMatch(html, /Add reference/);
  assert.doesNotMatch(html, /Portrait 9:16/);
  assert.doesNotMatch(html, /1K/);
  assert.doesNotMatch(html, /1024x1536/);
});
