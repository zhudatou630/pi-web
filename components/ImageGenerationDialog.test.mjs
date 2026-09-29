import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { ImageGenerationDialog, ratioLabel, resolutionLabel, qualityLabel } = await jiti.import("./ImageGenerationDialog.tsx");
const { enLocale } = await jiti.import("@/lib/i18n/messages/en");
const tr = (key) => enLocale.messages[key];

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
  // The pickers are menu-surface Selects: closed, they render only their trigger and selected label.
  assert.match(html, /aria-label="Aspect"[\s\S]*?>Auto</);
  assert.match(html, /aria-label="Resolution"[\s\S]*?>1K</);
  assert.match(html, /aria-label="Quality"[\s\S]*?>Auto</);
  assert.doesNotMatch(html, /1024x1536/);
  assert.doesNotMatch(html, /Choose target/);
  assert.doesNotMatch(html, /Add reference/);
});

test("option labels for ratios, resolution, and quality", () => {
  assert.equal(ratioLabel(tr, "auto"), "Auto");
  assert.equal(ratioLabel(tr, "1:1"), "Square 1:1");
  assert.equal(ratioLabel(tr, "9:16"), "Portrait 9:16");
  assert.equal(ratioLabel(tr, "16:9"), "Landscape 16:9");
  assert.equal(resolutionLabel("1k"), "1K");
  assert.equal(resolutionLabel("2k"), "2K");
  assert.equal(qualityLabel(tr, "low"), "Low");
  assert.equal(qualityLabel(tr, "medium"), "Medium");
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

test("a source image turns the direct dialog into an edit on editing connections only", () => {
  const renderWith = (connections, initialSourceImages, edit) => renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(ImageGenerationDialog, {
      config: { defaultConnection: connections[0].id, connections },
      initialSourceImages,
      edit,
      editPreviewUrl: edit ? "/api/files/result.png?type=read" : undefined,
      onClose() {},
      async onSubmit() {},
    }),
  ));
  const editor = { id: "editor", label: "Editor", provider: "xai", model: "image", capabilities: { editing: true } };
  const painter = { id: "painter", label: "Painter", provider: "xai", model: "image", capabilities: {} };
  const source = { data: "iVBORw0KGgo=", mimeType: "image/png" };

  const fresh = renderWith([painter, editor]);
  assert.match(fresh, /Add source image/);
  assert.match(fresh, />Painter</);

  const edit = renderWith([painter, editor], [source]);
  assert.match(edit, /Edit image/);
  assert.match(edit, /data:image\/png;base64,iVBORw0KGgo=/);
  assert.match(edit, /class="chat-input-image-remove"/);
  assert.doesNotMatch(edit, />Painter</);

  assert.doesNotMatch(edit, />1</);
  assert.doesNotMatch(renderWith([painter], [source]), /Add source image|Remove source image|Edit image/);

  // Several sources are numbered in request order; the edited result comes first and cannot be removed.
  const result = { type: "pi-image-result", version: 1, path: ".pi/generated-images/result.png", mimeType: "image/png", width: 1, height: 1, prompt: "result", connection: "editor", model: "image" };
  const combined = renderWith([editor], [source, source], result);
  assert.match(combined, /result\.png[\s\S]*>1<[\s\S]*>2<[\s\S]*>3</);
  assert.equal(combined.match(/class="chat-input-image-remove"/g).length, 2); // one remove button per removable source
  assert.match(combined, /Add source image/);
  // The reference limit hides the add button.
  assert.doesNotMatch(renderWith([editor], [source, source, source, source], result), /Add source image/);
});
