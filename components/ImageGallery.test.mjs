import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { ImageGallery } = await jiti.import("./ImageGallery.tsx");
const { ImageThumbs } = await jiti.import("./ImageThumbs.tsx");
const { ImageAttachmentStrip } = await jiti.import("./ImageAttachmentStrip.tsx");

const render = (element) => renderToStaticMarkup(React.createElement(I18nProvider, null, element));
const images = (n) => Array.from({ length: n }, (_, i) => ({ src: `data:image/png;base64,AAAA${i}` }));
const count = (html, pattern) => (html.match(pattern) ?? []).length;

test("gallery renders one capped, clickable image per item in the requested variant", () => {
  const figure = render(React.createElement(ImageGallery, { images: images(2) }));
  assert.equal(count(figure, /class="image-gallery-item"/g), 2);
  assert.equal(count(figure, /image-gallery-image is-figure/g), 2);
  const thumb = render(React.createElement(ImageGallery, { images: images(1), variant: "thumb" }));
  assert.match(thumb, /image-gallery-image is-thumb/);
});

test("message thumbnails fold everything past six into +N", () => {
  const html = render(React.createElement(ImageThumbs, { images: images(8) }));
  assert.equal(count(html, /class="image-thumb"/g), 6);
  assert.match(html, /image-thumb-more">\+2</);
  assert.doesNotMatch(render(React.createElement(ImageThumbs, { images: images(6) })), /image-thumb-more/);
});

test("attachment strip numbers images, and a locked leading image cannot be removed or dragged", () => {
  const props = { onMove() {}, onRemove() {} };
  const plain = render(React.createElement(ImageAttachmentStrip, { images: images(3), ...props }));
  assert.equal(count(plain, /class="image-thumb-index"/g), 3);
  assert.equal(count(plain, /class="chat-input-image-remove"/g), 3);
  assert.equal(count(plain, /draggable="true"/g), 3);

  const locked = render(React.createElement(ImageAttachmentStrip, { images: images(3), lockedCount: 1, ...props }));
  assert.equal(count(locked, /class="chat-input-image-remove"/g), 2);
  assert.equal(count(locked, /draggable="true"/g), 2);

  const single = render(React.createElement(ImageAttachmentStrip, { images: images(1), ...props }));
  assert.doesNotMatch(single, /image-thumb-index/);
  assert.doesNotMatch(single, /draggable="true"/);
});
