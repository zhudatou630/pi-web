import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ImageViewer.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("uses a native modal dialog and restores focus to the opener", () => {
  assert.match(source, /useRef<HTMLDialogElement>\(null\)/);
  assert.match(source, /dialog\.showModal\(\)/);
  assert.match(source, /const opener = document\.activeElement[\s\S]*?opener\?\.isConnected[\s\S]*?opener\.focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(source, /createPortal/);
});

test("Escape closes the viewer without reaching global shortcuts", () => {
  assert.match(source, /event\.key === "Escape"[\s\S]*?event\.preventDefault\(\)[\s\S]*?event\.stopPropagation\(\)[\s\S]*?requestClose\(\)/);
  assert.match(source, /onCancel=\{\(event\) => \{[\s\S]*?event\.preventDefault\(\)[\s\S]*?event\.stopPropagation\(\)[\s\S]*?requestClose\(\)/);
});

test("mouse click closes on the backdrop or an unzoomed image; arrows navigate", () => {
  assert.match(source, /!downOnImage\.current \|\| view\.s === 1\) requestClose\(\)/);
  assert.match(source, /"ArrowLeft"\) slideTo\(index - 1\)/);
  assert.match(source, /"ArrowRight"\) slideTo\(index \+ 1\)/);
});

test("keeps the viewer and toolbar inside mobile safe areas", () => {
  assert.match(
    cssSource,
    /\.image-preview-dialog \{[\s\S]*?env\(safe-area-inset-top\)[\s\S]*?env\(safe-area-inset-right\)[\s\S]*?env\(safe-area-inset-bottom\)[\s\S]*?env\(safe-area-inset-left\)/,
  );
  assert.match(
    cssSource,
    /\.image-viewer-toolbar \{[\s\S]*?top: max\(12px, env\(safe-area-inset-top\)\)[\s\S]*?right: max\(12px, env\(safe-area-inset-right\)\)/,
  );
  assert.match(cssSource, /@media \(pointer: coarse\) \{\s*\.image-viewer-button \{ width: 40px; height: 40px; \}/);
});
